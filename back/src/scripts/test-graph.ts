// Script JETABLE de validation bout en bout du vrai pipeline (nœud ingestor branché
// sur back/src/lib/extraction.ts). À supprimer après usage, jamais committé.
//
// Insère 3 documents de test, les traite via runPipeline() (le vrai graphe, pas
// test-ocr.ts directement), puis vérifie en base : documents.statut_traitement/
// type_echec, la table extraction, et les checkpoints du graphe.

import { config } from 'dotenv';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { runPipeline } from '../graph/pipeline.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

function usageAndExit(): never {
  console.error('Usage: npx tsx src/scripts/test-graph.ts <chemin-vers-dossier-factures>');
  process.exit(1);
}

const TEST_FILES = ['DOC-060.pdf', 'DOC-061.jpg', 'DOC-039.jpg'];

async function main(): Promise<void> {
  const facturesDir = process.argv[2];
  if (!facturesDir) {
    usageAndExit();
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Étape 3 : insertion des 3 documents de test (statut_traitement par défaut 'en_attente').
    const documentIds: number[] = [];
    for (const fileName of TEST_FILES) {
      const cheminFichier = join(facturesDir, fileName);
      const type = extname(fileName).slice(1).toLowerCase();
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO documents (type, chemin_fichier) VALUES ($1, $2) RETURNING id`,
        [type, cheminFichier],
      );
      const id = inserted.rows[0]!.id;
      documentIds.push(id);
      console.log(`Document inséré : id=${id} fichier=${fileName}`);
    }

    // Étape 4 : traitement via le vrai graphe (runPipeline), pas test-ocr.ts.
    console.log('\n=== Traitement via runPipeline() ===');
    for (let i = 0; i < documentIds.length; i += 1) {
      const id = documentIds[i]!;
      const fileName = TEST_FILES[i]!;
      const cheminFichier = join(facturesDir, fileName);
      console.log(`\n--- Document id=${id} (${fileName}) ---`);
      const finalState = await runPipeline(id, cheminFichier);
      console.log(JSON.stringify(finalState, null, 2));
    }

    // Vérification 1 : documents.statut_traitement / type_echec
    console.log('\n=== Vérification documents ===');
    const documentsRows = await client.query(
      `SELECT id, type, chemin_fichier, statut_traitement, type_echec, motif_echec
       FROM documents
       WHERE id = ANY($1)
       ORDER BY id`,
      [documentIds],
    );
    for (const row of documentsRows.rows) {
      console.log(
        `id=${row.id} fichier=${basename(row.chemin_fichier)} statut_traitement=${row.statut_traitement} type_echec=${row.type_echec} motif_echec=${row.motif_echec}`,
      );
    }

    // Vérification 2 : table extraction
    console.log('\n=== Vérification extraction ===');
    const extractionRows = await client.query(
      `SELECT document_id, tiers, date, ht, tva, ttc, taux_tva, numero_piece,
              ice_fournisseur, ice_client, confiance, score_nettete, nombre_appels_llm,
              extraction_alternative IS NOT NULL AS a_une_alternative
       FROM extraction
       WHERE document_id = ANY($1)
       ORDER BY document_id`,
      [documentIds],
    );
    if (extractionRows.rows.length === 0) {
      console.log('Aucune ligne dans extraction pour ces documents.');
    }
    for (const row of extractionRows.rows) {
      console.log(JSON.stringify(row, null, 2));
    }

    // Vérification 3 : checkpoints du graphe pour ces 3 thread_id
    console.log('\n=== Vérification checkpoints ===');
    const threadIds = documentIds.map((id) => `document-${id}`);
    const checkpointRows = await client.query<{ thread_id: string; count: string }>(
      `SELECT thread_id, COUNT(*) AS count
       FROM checkpoints
       WHERE thread_id = ANY($1)
       GROUP BY thread_id
       ORDER BY thread_id`,
      [threadIds],
    );
    for (const row of checkpointRows.rows) {
      console.log(`${row.thread_id} : ${row.count} checkpoint(s)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[test-graph] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
