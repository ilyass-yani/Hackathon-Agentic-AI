import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, END, START, StateGraph, type NodeError, type Runtime } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Decimal } from 'decimal.js';
import pg from 'pg';
import { extraireDocument, type ExtractedInvoice } from '../lib/extraction.js';
import { rapprocher, type FactureCandidate, type ResultatRapprochement } from '../lib/reconciliation.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

export const PipelineState = Annotation.Root({
  documentId: Annotation<number>,
  cheminFichier: Annotation<string>,
  statut: Annotation<string>,
  extraction: Annotation<ExtractedInvoice | null>,
  motifEchec: Annotation<string | null>,
  anomalies: Annotation<unknown[]>,
  erreurs: Annotation<string[]>,
  // Compteur de tentatives techniques sur ce document (pas incrémenté nous-mêmes :
  // LangGraph rejoue le nœud lui-même sur erreur, on lit juste le nombre de tentatives
  // effectivement faites via runtime.executionInfo.nodeAttempt une fois épuisé).
  tentativesTechniques: Annotation<number>,
  // 'technique' = échec transitoire, retry déjà tenté et épuisé. 'metier' = doute réel
  // sur le contenu, jamais de retry (un retry ne résoudrait rien). null = pas d'échec.
  typeEchec: Annotation<'technique' | 'metier' | null>,
});

// Même politique pour ingestor et reconciler : maxAttempts=3, mêmes raisons
// (distinguer erreur technique retryable de résultat métier normal).
const NODE_MAX_ATTEMPTS = 3;

// Pool dédié aux écritures Postgres du nœud ingestor — distinct du pool interne du
// checkpointer (privé à PostgresSaver, pas exposé pour des requêtes arbitraires).
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Ingestor : appelle la vraie logique d'extraction (back/src/lib/extraction.ts), ne
// duplique rien. Une erreur technique (réseau/API/Postgres transitoire) n'est jamais
// catchée ici : elle remonte telle quelle, le retryPolicy + errorHandler ci-dessous
// s'en chargent (déjà testés sur le placeholder, logique inchangée). Un résultat
// métier normal (même statut='non_traite') n'est PAS une erreur : on écrit direct.
async function ingestor(
  state: typeof PipelineState.State,
  runtime: Runtime,
): Promise<Partial<typeof PipelineState.State>> {
  const attempt = runtime.executionInfo?.nodeAttempt ?? 1;
  console.log(`Node ingestor: document ${state.documentId} (tentative ${attempt}/${NODE_MAX_ATTEMPTS})`);

  const resultat = await extraireDocument(state.cheminFichier);

  // statut != 'traite' est un doute métier (contenu suspect ou illisible), jamais
  // 'technique' ici : une erreur technique n'atteint jamais ce point (elle a throw
  // plus haut et est gérée par retryPolicy/errorHandler, pas par ce chemin normal).
  const typeEchec: 'metier' | null = resultat.statut === 'traite' ? null : 'metier';

  await pool.query(
    `UPDATE documents
     SET statut_traitement = $1, motif_echec = $2, type_echec = $3
     WHERE id = $4`,
    [resultat.statut, resultat.motif, typeEchec, state.documentId],
  );

  // Upsert : un document a au plus une extraction (document_id UNIQUE), on écrase
  // proprement si le document est retraité.
  await pool.query(
    `INSERT INTO extraction (
       document_id, tiers, date, ht, tva, ttc, taux_tva, numero_piece,
       ice_fournisseur, ice_client, confiance, score_nettete, nombre_appels_llm,
       extraction_alternative
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (document_id) DO UPDATE SET
       tiers = EXCLUDED.tiers,
       date = EXCLUDED.date,
       ht = EXCLUDED.ht,
       tva = EXCLUDED.tva,
       ttc = EXCLUDED.ttc,
       taux_tva = EXCLUDED.taux_tva,
       numero_piece = EXCLUDED.numero_piece,
       ice_fournisseur = EXCLUDED.ice_fournisseur,
       ice_client = EXCLUDED.ice_client,
       confiance = EXCLUDED.confiance,
       score_nettete = EXCLUDED.score_nettete,
       nombre_appels_llm = EXCLUDED.nombre_appels_llm,
       extraction_alternative = EXCLUDED.extraction_alternative,
       updated_at = now()`,
    [
      state.documentId,
      resultat.extraction?.tiers ?? null,
      resultat.extraction?.date ?? null,
      resultat.extraction?.ht ?? null,
      resultat.extraction?.tva ?? null,
      resultat.extraction?.ttc ?? null,
      resultat.extraction?.taux_tva ?? null,
      resultat.extraction?.numero_piece ?? null,
      resultat.extraction?.ice_fournisseur ?? null,
      resultat.extraction?.ice_client ?? null,
      resultat.extraction?.confiance ?? null,
      resultat.scoreNettete,
      resultat.nombreAppelsLlm,
      resultat.extractionAlternative ? JSON.stringify(resultat.extractionAlternative) : null,
    ],
  );

  return {
    statut: resultat.statut,
    extraction: resultat.extraction,
    motifEchec: resultat.motif,
    typeEchec,
  };
}

// Écrit le résultat d'un rapprocher() en base. Upsert via la clé naturelle
// (document_id, releve_ligne_id) sur rapprochement_ligne (contrainte UNIQUE ajoutée
// par migration) : rapprochement lui-même n'a pas de document_id direct (c'est une
// enveloppe de groupe, potentiellement partagée entre plusieurs documents d'un
// paiement groupé) — on retrouve un rapprochement existant pour CE document via ses
// éventuelles rapprochement_ligne d'un run précédent.
//
// Limitation connue et acceptée pour cette étape : pour 'non_rapproche', il n'y a
// aucune releve_ligne à lier, donc aucune rapprochement_ligne écrite — et sans elle,
// aucune clé ne permet de retrouver "le" rapprochement non_rapproche déjà écrit pour
// ce document lors d'un run précédent. Un re-traitement d'un document en
// non_rapproche crée donc un nouveau rapprochement orphelin à chaque fois. À revoir
// avant le passage à l'échelle sur les 107 documents si ça devient gênant.
async function ecrireRapprochement(
  documentId: number,
  releveLigneId: number | null,
  resultat: ResultatRapprochement,
): Promise<void> {
  // rapprochement_id/id sont des BIGINT -> string côté node-postgres, jamais number
  // par défaut ; Number(...) explicite pour rester cohérent avec le reste du fichier.
  const existant = await pool.query<{ rapprochement_id: string }>(
    `SELECT DISTINCT rapprochement_id FROM rapprochement_ligne WHERE document_id = $1`,
    [documentId],
  );

  let rapprochementId: number;
  if (existant.rows.length > 0) {
    rapprochementId = Number(existant.rows[0]!.rapprochement_id);
    await pool.query(`UPDATE rapprochement SET statut = $1, updated_at = now() WHERE id = $2`, [
      resultat.statut,
      rapprochementId,
    ]);
    // rapprocher() est déterministe : recalculer depuis n'importe quel membre du
    // groupe doit reproduire le même résultat pour tout le groupe, donc on peut
    // réécrire les lignes sans perte d'information.
    await pool.query(`DELETE FROM rapprochement_ligne WHERE rapprochement_id = $1`, [rapprochementId]);
  } else {
    const insere = await pool.query<{ id: string }>(`INSERT INTO rapprochement (statut) VALUES ($1) RETURNING id`, [
      resultat.statut,
    ]);
    rapprochementId = Number(insere.rows[0]!.id);
  }

  if (releveLigneId !== null) {
    for (const impute of resultat.montantImpute) {
      await pool.query(
        `INSERT INTO rapprochement_ligne (rapprochement_id, document_id, releve_ligne_id, montant_impute)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, releve_ligne_id) DO UPDATE SET
           rapprochement_id = EXCLUDED.rapprochement_id,
           montant_impute = EXCLUDED.montant_impute`,
        [rapprochementId, impute.documentId, releveLigneId, impute.montant.toFixed(2)],
      );
    }
  }
}

// Reconciler : appelle rapprocher() (back/src/lib/reconciliation.ts, fonction pure),
// écrit le résultat en base. Ne s'exécute que sur un document déjà 'traite' par
// l'ingestor — sans extraction fiable, rapprocher n'importe quoi n'aurait aucun sens.
async function reconciler(
  state: typeof PipelineState.State,
  runtime: Runtime,
): Promise<Partial<typeof PipelineState.State>> {
  const attempt = runtime.executionInfo?.nodeAttempt ?? 1;
  console.log(`Node reconciler: document ${state.documentId} (tentative ${attempt}/${NODE_MAX_ATTEMPTS})`);

  if (state.statut !== 'traite' || !state.extraction) {
    console.log(
      `Node reconciler: document ${state.documentId} skip — statut='${state.statut}', pas de données fiables à rapprocher.`,
    );
    return {};
  }

  const { tiers, ttc, date } = state.extraction;
  if (!tiers || ttc === null || !date) {
    console.log(`Node reconciler: document ${state.documentId} skip — tiers/ttc/date manquant malgré statut='traite'.`);
    return {};
  }

  // Lignes bancaires candidates pour ce fournisseur : même logique de matching que
  // check-regroupements.ts (fournisseur_nom_brut <-> tiers, insensible à la casse),
  // mais en sens inverse (on part de la facture, pas de la ligne) puisqu'on traite un
  // document à la fois. Règle 9 : paiement jusqu'à 60 jours après la facture.
  const lignesCandidates = await pool.query<{ id: string; date: string; debit: string }>(
    `SELECT id, date::text, debit::text
     FROM releve_ligne
     WHERE type_detecte = 'paiement_fournisseur'
       AND debit IS NOT NULL
       AND LOWER(TRIM(fournisseur_nom_brut)) = LOWER(TRIM($1))
       AND date BETWEEN $2::date AND ($2::date + INTERVAL '60 days')
     ORDER BY date`,
    [tiers, date],
  );

  if (lignesCandidates.rows.length === 0) {
    console.log(`Node reconciler: document ${state.documentId} -> non_rapproche (aucune ligne bancaire candidate).`);
    await ecrireRapprochement(state.documentId, null, {
      statut: 'non_rapproche',
      documentIds: [],
      montantImpute: [],
      soldeRestant: null,
    });
    return {};
  }

  // Toutes les factures "sœurs" du même fournisseur : pool de candidats pour
  // rapprocher(), qui fait lui-même son propre filtrage de fenêtre de 60 jours
  // (avant chaque ligne bancaire candidate) — pas besoin de le refaire ici.
  // node-postgres renvoie les colonnes BIGINT/BIGSERIAL (document_id, id) en string,
  // pas en number (pour ne pas perdre de précision au-delà de Number.MAX_SAFE_INTEGER)
  // — Number(...) explicite ici, sinon `documentIds.includes(state.documentId)` plus
  // bas compare silencieusement une string à un number et ne matche jamais.
  const facturesSoeurs = await pool.query<{ document_id: string; date: string; ttc: string }>(
    `SELECT e.document_id, e.date::text, e.ttc::text
     FROM extraction e
     JOIN documents d ON d.id = e.document_id
     WHERE d.statut_traitement = 'traite'
       AND e.date IS NOT NULL
       AND e.ttc IS NOT NULL
       AND LOWER(TRIM(e.tiers)) = LOWER(TRIM($1))`,
    [tiers],
  );

  const facturesCandidates: FactureCandidate[] = facturesSoeurs.rows.map((f) => ({
    documentId: Number(f.document_id),
    date: new Date(f.date),
    ttc: new Decimal(f.ttc),
  }));

  let resultat: ResultatRapprochement | null = null;
  let releveLigneId: number | null = null;

  for (const ligne of lignesCandidates.rows) {
    const candidat = rapprocher(tiers, new Decimal(ligne.debit), new Date(ligne.date), facturesCandidates);
    if (candidat.statut !== 'non_rapproche' && candidat.documentIds.includes(state.documentId)) {
      resultat = candidat;
      releveLigneId = Number(ligne.id);
      break;
    }
  }

  if (!resultat) {
    resultat = { statut: 'non_rapproche', documentIds: [], montantImpute: [], soldeRestant: null };
  }

  console.log(
    `Node reconciler: document ${state.documentId} -> ${resultat.statut}` +
      (resultat.documentIds.length > 1 ? ` (groupe: ${resultat.documentIds.join(', ')})` : ''),
  );

  await ecrireRapprochement(state.documentId, releveLigneId, resultat);

  return {};
}

const graph = new StateGraph(PipelineState)
  .addNode('ingestor', ingestor, {
    retryPolicy: { maxAttempts: NODE_MAX_ATTEMPTS },
    // N'est appelé qu'une fois le retryPolicy épuisé (jamais pour un doute métier,
    // qui ne lève pas d'exception) : c'est ici, et seulement ici, qu'on persiste
    // proprement l'échec technique dans le state plutôt que de laisser l'exception
    // remonter non gérée. Logique inchangée depuis le placeholder (déjà testée) :
    // ne persiste que dans le state/checkpoint, pas dans Postgres — un problème
    // réseau n'est pas un jugement sur le document, l'escalade humaine définitive
    // sera un nœud séparé, pas encore écrit.
    errorHandler: (_state: typeof PipelineState.State, error: NodeError) => {
      console.log(
        `Node ingestor: échec technique après ${NODE_MAX_ATTEMPTS} tentatives — ${error.error.message}`,
      );
      return { typeEchec: 'technique', tentativesTechniques: NODE_MAX_ATTEMPTS };
    },
  })
  .addNode('reconciler', reconciler, {
    retryPolicy: { maxAttempts: NODE_MAX_ATTEMPTS },
    // Même raison que sur ingestor : une erreur Postgres/réseau ici est technique,
    // pas un jugement sur le document. rapprocher() lui-même est pur (pas d'I/O),
    // seules les requêtes/écritures autour peuvent échouer techniquement.
    errorHandler: (_state: typeof PipelineState.State, error: NodeError) => {
      console.log(
        `Node reconciler: échec technique après ${NODE_MAX_ATTEMPTS} tentatives — ${error.error.message}`,
      );
      return { typeEchec: 'technique', tentativesTechniques: NODE_MAX_ATTEMPTS };
    },
  })
  .addEdge(START, 'ingestor')
  .addEdge('ingestor', 'reconciler')
  .addEdge('reconciler', END);

async function buildCheckpointedGraph(): Promise<{ app: ReturnType<typeof graph.compile>; checkpointer: PostgresSaver }> {
  // PostgresSaver a besoin de ses propres tables internes (checkpoints,
  // checkpoint_writes, checkpoint_blobs, ...). setup() les crée/migre
  // automatiquement (méthode recommandée par le package) : pas de migration
  // node-pg-migrate à écrire à la main pour ça.
  const checkpointer = PostgresSaver.fromConnString(DATABASE_URL as string);
  await checkpointer.setup();
  return { app: graph.compile({ checkpointer }), checkpointer };
}

// Un seul Pool/checkpointer pour tout le process en usage normal : on compile le
// graphe une fois, paresseusement, et on réutilise l'instance pour tous les appels.
let current: Promise<{ app: ReturnType<typeof graph.compile>; checkpointer: PostgresSaver }> | null = null;

function getCompiledGraph() {
  if (!current) {
    current = buildCheckpointedGraph();
  }
  return current;
}

// Réservé au test de résilience (test-graph.ts) : construit un TOUT NOUVEAU
// checkpointer/pool, indépendant de celui utilisé par runPipeline(), comme le
// ferait un worker qui redémarre à froid.
export async function buildFreshApp() {
  return buildCheckpointedGraph();
}

// Réservé au test de résilience : ferme la connexion du checkpointer actuellement
// utilisé par runPipeline() et force la reconstruction d'un nouveau au prochain appel.
export async function closePipelineConnection(): Promise<void> {
  if (!current) {
    return;
  }
  const { checkpointer } = await current;
  await checkpointer.end();
  current = null;
}

export async function runPipeline(documentId: number, cheminFichier: string): Promise<typeof PipelineState.State> {
  const { app } = await getCompiledGraph();

  const initialState: typeof PipelineState.State = {
    documentId,
    cheminFichier,
    statut: 'en_attente',
    extraction: null,
    motifEchec: null,
    anomalies: [],
    erreurs: [],
    tentativesTechniques: 0,
    typeEchec: null,
  };

  // thread_id = identité de la conversation/exécution pour le checkpointer : un
  // document = un thread, pour pouvoir reprendre/consulter son historique plus tard.
  return app.invoke(initialState, { configurable: { thread_id: `document-${documentId}` } });
}
