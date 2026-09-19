// Script JETABLE — validation limitée du nœud "reconciler" fraîchement branché
// (ingestor -> reconciler -> END). PAS le batch complet : 3 documents déjà connus et
// déjà traités par l'ingestor, choisis pour couvrir rapproche ET non_rapproche.

import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { runPipeline } from '../graph/pipeline.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

// id=5   : DOC-060.pdf, SOMAFER SARL — devrait matcher simplement une ligne bancaire
//          (pas la ligne #57 REGROUPEMENT, une autre, plus simple).
// id=44  : ENERGIE PLUS — un des 3 documents candidats investigués pour la ligne #69
//          (REGROUPEMENT non_rapproché) ; a sa propre ligne simple séparée.
// id=62  : ENERGIE PLUS — autre candidat de la même investigation #69 ; confirmé sans
//          aucune ligne correspondante lors du diagnostic précédent -> non_rapproche attendu.
const DOCUMENT_IDS = [5, 44, 62];

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    for (const documentId of DOCUMENT_IDS) {
      const row = await client.query<{ chemin_fichier: string }>('SELECT chemin_fichier FROM documents WHERE id = $1', [
        documentId,
      ]);
      if (row.rows.length === 0) {
        console.error(`Document id=${documentId} introuvable, abandon.`);
        process.exit(1);
      }
      const cheminFichier = row.rows[0]!.chemin_fichier;

      console.log(`\n--- Document id=${documentId} (${cheminFichier}) ---`);
      const finalState = await runPipeline(documentId, cheminFichier);
      console.log(JSON.stringify(finalState, null, 2));
    }

    console.log('\n=== Vérification rapprochement/rapprochement_ligne ===');
    for (const documentId of DOCUMENT_IDS) {
      const lignes = await client.query(
        `SELECT rl.rapprochement_id, r.statut, rl.releve_ligne_id, rl.montant_impute, r2.libelle, r2.debit
         FROM rapprochement_ligne rl
         JOIN rapprochement r ON r.id = rl.rapprochement_id
         JOIN releve_ligne r2 ON r2.id = rl.releve_ligne_id
         WHERE rl.document_id = $1`,
        [documentId],
      );

      if (lignes.rows.length === 0) {
        console.log(`document_id=${documentId} : aucune rapprochement_ligne (probablement non_rapproche).`);
      } else {
        for (const row of lignes.rows) {
          console.log(
            `document_id=${documentId} : rapprochement_id=${row.rapprochement_id} statut=${row.statut} ` +
              `releve_ligne_id=${row.releve_ligne_id} ("${row.libelle}", debit=${row.debit}) montant_impute=${row.montant_impute}`,
          );
        }
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[test-graph] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
