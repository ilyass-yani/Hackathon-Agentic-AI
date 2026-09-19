// Lance le vrai pipeline (runPipeline via le graphe LangGraph, écrit en Postgres)
// sur tous les PDF/JPG d'un dossier. Contrairement à test-ocr.ts en mode batch (qui
// n'écrit que dans un fichier JSON), ce script passe par le graphe complet : nœud
// ingestor, retryPolicy, checkpointer Postgres, écriture documents/extraction.

import { config } from 'dotenv';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { runPipeline } from '../graph/pipeline.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg']);

function usageAndExit(): never {
  console.error(
    'Usage: npx tsx src/scripts/run-pipeline-batch.ts <chemin-vers-dossier-factures>\n' +
      '  Traite tous les PDF/JPG du dossier via le vrai pipeline (runPipeline), en séquentiel.\n' +
      '  Relançable : les documents déjà traités (statut_traitement != en_attente) sont skippés.',
  );
  process.exit(1);
}

async function listCandidateFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dirPath, entry.name))
    .sort();
}

interface DocumentRow {
  id: number;
  statut_traitement: string;
}

// Idempotent : réutilise la ligne existante par chemin_fichier plutôt que d'en
// recréer une à chaque relance du script.
async function getOrCreateDocument(client: Client, cheminFichier: string): Promise<DocumentRow> {
  const existing = await client.query<DocumentRow>(
    'SELECT id, statut_traitement FROM documents WHERE chemin_fichier = $1',
    [cheminFichier],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0]!;
  }

  const type = extname(cheminFichier).slice(1).toLowerCase();
  const inserted = await client.query<DocumentRow>(
    'INSERT INTO documents (type, chemin_fichier) VALUES ($1, $2) RETURNING id, statut_traitement',
    [type, cheminFichier],
  );
  return inserted.rows[0]!;
}

async function main(): Promise<void> {
  const facturesDir = process.argv[2];
  if (!facturesDir) {
    usageAndExit();
  }

  const files = await listCandidateFiles(facturesDir);
  if (files.length === 0) {
    console.error(`[run-pipeline-batch] Aucun fichier PDF/JPG trouvé dans ${facturesDir}`);
    process.exit(1);
  }

  console.log(`[run-pipeline-batch] ${files.length} fichier(s) PDF/JPG trouvé(s) dans ${facturesDir}.`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const start = performance.now();
  const statutCounts: Record<'traite' | 'a_verifier' | 'non_traite', number> = {
    traite: 0,
    a_verifier: 0,
    non_traite: 0,
  };
  let skippedCount = 0;
  let echecTechniqueCount = 0;
  let echecScriptCount = 0;

  try {
    for (let i = 0; i < files.length; i += 1) {
      const cheminFichier = files[i]!;
      const fileName = basename(cheminFichier);
      const prefix = `[${i + 1}/${files.length}]`;

      const document = await getOrCreateDocument(client, cheminFichier);

      if (document.statut_traitement !== 'en_attente') {
        skippedCount += 1;
        console.log(`${prefix} SKIP ${fileName} (id=${document.id}, déjà statut_traitement=${document.statut_traitement})`);
        continue;
      }

      console.log(`${prefix} Traitement ${fileName} (id=${document.id})...`);

      try {
        // Séquentiel volontairement : pas de Promise.all sur plusieurs documents,
        // pour ne pas cramer le quota LLM avec des appels concurrents (le worker
        // cible traite un job à la fois de toute façon).
        const finalState = await runPipeline(document.id, cheminFichier);

        if (finalState.typeEchec === 'technique') {
          // retryPolicy épuisé côté ingestor : errorHandler a déjà persisté ça dans
          // le state/checkpoint, mais pas dans documents (cf. pipeline.ts) —
          // l'escalade humaine définitive est un nœud pas encore écrit.
          echecTechniqueCount += 1;
          console.log(
            `${prefix} ${fileName} (id=${document.id}) → ÉCHEC TECHNIQUE après ${finalState.tentativesTechniques} tentatives (statut_traitement reste 'en_attente' en base).`,
          );
        } else {
          // finalState.statut est typé string côté graphe (Annotation<string>), mais
          // vaut toujours 'traite' | 'a_verifier' | 'non_traite' ici : typeEchec
          // !== 'technique' signifie que le nœud a fini normalement, donc resultat.statut
          // (StatutExtraction) a été écrit tel quel par l'ingestor.
          const statut = finalState.statut as 'traite' | 'a_verifier' | 'non_traite';
          statutCounts[statut] += 1;
          console.log(`${prefix} ${fileName} (id=${document.id}) → ${statut}`);
        }
      } catch (error) {
        echecScriptCount += 1;
        console.error(
          `${prefix} ÉCHEC NON GÉRÉ sur ${fileName} (id=${document.id}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    await client.end();
  }

  const elapsedMinutes = (performance.now() - start) / 1000 / 60;

  console.log('\n=== Résumé batch ===');
  console.log(`Fichiers trouvés : ${files.length}`);
  console.log(`Skippés (déjà traités) : ${skippedCount}`);
  console.log(`  - traite : ${statutCounts.traite}`);
  console.log(`  - a_verifier : ${statutCounts.a_verifier}`);
  console.log(`  - non_traite : ${statutCounts.non_traite}`);
  console.log(`Échecs techniques (retry épuisé) : ${echecTechniqueCount}`);
  console.log(`Échecs non gérés (script) : ${echecScriptCount}`);
  console.log(`Temps total : ${elapsedMinutes.toFixed(1)} min`);
}

main().catch((error: unknown) => {
  console.error('[run-pipeline-batch] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
