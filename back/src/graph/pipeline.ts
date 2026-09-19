import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, END, START, StateGraph, type NodeError, type Runtime } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { extraireDocument, type ExtractedInvoice } from '../lib/extraction.js';

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

const INGESTOR_MAX_ATTEMPTS = 3;

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
  console.log(`Node ingestor: document ${state.documentId} (tentative ${attempt}/${INGESTOR_MAX_ATTEMPTS})`);

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

const graph = new StateGraph(PipelineState)
  .addNode('ingestor', ingestor, {
    retryPolicy: { maxAttempts: INGESTOR_MAX_ATTEMPTS },
    // N'est appelé qu'une fois le retryPolicy épuisé (jamais pour un doute métier,
    // qui ne lève pas d'exception) : c'est ici, et seulement ici, qu'on persiste
    // proprement l'échec technique dans le state plutôt que de laisser l'exception
    // remonter non gérée. Logique inchangée depuis le placeholder (déjà testée) :
    // ne persiste que dans le state/checkpoint, pas dans Postgres — un problème
    // réseau n'est pas un jugement sur le document, l'escalade humaine définitive
    // sera un nœud séparé, pas encore écrit.
    errorHandler: (_state: typeof PipelineState.State, error: NodeError) => {
      console.log(
        `Node ingestor: échec technique après ${INGESTOR_MAX_ATTEMPTS} tentatives — ${error.error.message}`,
      );
      return { typeEchec: 'technique', tentativesTechniques: INGESTOR_MAX_ATTEMPTS };
    },
  })
  .addEdge(START, 'ingestor')
  .addEdge('ingestor', END);

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
