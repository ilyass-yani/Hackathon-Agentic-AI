// Script JETABLE de validation du squelette LangGraph (state + checkpointer Postgres +
// exécution d'un nœud). Ne branche PAS le vrai Ingestor. À supprimer après usage.

import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { buildFreshApp, closePipelineConnection, runPipeline } from '../graph/pipeline.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

async function main(): Promise<void> {
  const finalState = await runPipeline(999, 'test.pdf');

  console.log('=== State final ===');
  console.log(JSON.stringify(finalState, null, 2));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'checkpoint%'
       ORDER BY table_name`,
    );

    console.log('\n=== Tables créées par le checkpointer Postgres (setup()) ===');
    for (const row of tables.rows) {
      console.log(`- ${row.table_name}`);
    }

    const checkpointRows = await client.query(
      `SELECT thread_id, checkpoint_ns, checkpoint_id
       FROM checkpoints
       WHERE thread_id = $1
       ORDER BY checkpoint_id`,
      ['document-999'],
    );

    console.log("\n=== Lignes checkpoints pour thread_id='document-999' ===");
    console.log(JSON.stringify(checkpointRows.rows, null, 2));
  } finally {
    await client.end();
  }

  // Test de résilience au redémarrage — pattern inspiré de
  // github.com/manuelbomi/LangGraph-based-Invoice-Receipt-Audit-Reconciliation-Assistant
  // (même scénario : un document peut rester en attente de revue pendant qu'un
  // worker redémarre, l'état doit survivre à la coupure de connexion).
  console.log('\n=== Test de résilience au redémarrage (document-1000) ===');

  const threadId = 'document-1000';
  const stateBeforeRestart = await runPipeline(1000, 'test-resilience.pdf');
  console.log('State avant "redémarrage" :');
  console.log(JSON.stringify(stateBeforeRestart, null, 2));

  // Fermeture complète de la connexion du checkpointer actuel — pas juste une
  // nouvelle requête, un vrai pool.end() sous le capot.
  await closePipelineConnection();
  console.log('Connexion du checkpointer fermée (pool.end()).');

  // Reconstruction à froid : nouveau checkpointer, nouvelle connexion Postgres,
  // nouveau graphe compilé — exactement ce que ferait un worker qui redémarre.
  const { app: freshApp, checkpointer: freshCheckpointer } = await buildFreshApp();
  try {
    const snapshot = await freshApp.getState({ configurable: { thread_id: threadId } });
    const stateAfterRestart = snapshot.values;

    console.log('State récupéré après "redémarrage" (nouvelle connexion) :');
    console.log(JSON.stringify(stateAfterRestart, null, 2));

    const identical = JSON.stringify(stateBeforeRestart) === JSON.stringify(stateAfterRestart);
    if (identical) {
      console.log('RÉSILIENT ✓ : état identique avant/après redémarrage simulé.');
    } else {
      console.log("PROBLÈME ✗ : l'état récupéré après redémarrage diffère de l'état avant fermeture de connexion.");
    }
  } finally {
    await freshCheckpointer.end();
  }
}

main().catch((error: unknown) => {
  console.error('[test-graph] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
