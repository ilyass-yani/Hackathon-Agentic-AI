// Script JETABLE, LECTURE SEULE — vérifie l'hypothèse "une ligne est_regroupement
// correspond à la somme de plusieurs factures du même fournisseur, proches en date"
// avant d'écrire lib/reconciliation.ts. Aucune écriture en base. À supprimer après usage.
//
// ATTENTION : au moment où ce script est écrit, seuls 3 documents (DOC-060, DOC-061,
// DOC-039) ont été traités par le vrai pipeline — la table extraction est très
// incomplète face aux 107 factures du corpus. Si aucune combinaison n'est trouvée,
// ça peut simplement vouloir dire "pas assez de factures encore extraites", pas que
// l'hypothèse est fausse. Le script le dit explicitement plutôt que de conclure.

import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import { Client } from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const FENETRE_JOURS = 90;
const TOLERANCE = new Decimal('0.01');
const TAILLES_COMBINAISON = [2, 3, 4];

interface LigneRegroupement {
  id: number;
  date: string;
  libelle: string;
  fournisseur_nom_brut: string;
  debit: string;
}

interface FactureCandidate {
  document_id: number;
  date: string;
  ttc: string | null;
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  const withFirst = combinations(rest, size - 1).map((c) => [first as T, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

function findMatchingCombinations(
  candidates: FactureCandidate[],
  target: Decimal,
): { taille: number; factures: FactureCandidate[]; somme: Decimal }[] {
  const avecTtc = candidates.filter((c): c is FactureCandidate & { ttc: string } => c.ttc !== null);
  const matches: { taille: number; factures: FactureCandidate[]; somme: Decimal }[] = [];

  for (const taille of TAILLES_COMBINAISON) {
    for (const combo of combinations(avecTtc, taille)) {
      const somme = combo.reduce((acc, f) => acc.plus(new Decimal(f.ttc as string)), new Decimal(0));
      if (somme.minus(target).abs().lessThanOrEqualTo(TOLERANCE)) {
        matches.push({ taille, factures: combo, somme });
      }
    }
  }
  return matches;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const totalExtraction = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM extraction');
    const totalDocuments = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM documents');
    console.log(
      `[contexte] extraction : ${totalExtraction.rows[0]!.count} ligne(s) / documents : ${totalDocuments.rows[0]!.count} ligne(s) au total.`,
    );

    const lignesRegroupement = await client.query<LigneRegroupement>(
      `SELECT id, date::text, libelle, fournisseur_nom_brut, debit::text
       FROM releve_ligne
       WHERE est_regroupement = true
       ORDER BY date`,
    );

    console.log(`\n${lignesRegroupement.rows.length} ligne(s) est_regroupement=true trouvée(s).\n`);

    let auMoinsUnMatch = false;
    let candidatsInsuffisantsCount = 0;

    for (const ligne of lignesRegroupement.rows) {
      console.log('='.repeat(70));
      console.log(
        `Ligne releve_ligne #${ligne.id} : ${ligne.date} — "${ligne.libelle}" — fournisseur_nom_brut="${ligne.fournisseur_nom_brut}" — debit=${ligne.debit}`,
      );

      const candidats = await client.query<FactureCandidate>(
        `SELECT e.document_id, e.date::text, e.ttc::text
         FROM extraction e
         WHERE LOWER(TRIM(e.tiers)) = LOWER(TRIM($1))
           AND e.date IS NOT NULL
           AND e.date BETWEEN ($2::date - ($3 || ' days')::interval) AND $2::date
         ORDER BY e.date`,
        [ligne.fournisseur_nom_brut, ligne.date, FENETRE_JOURS],
      );

      if (candidats.rows.length === 0) {
        console.log(
          `  Aucune facture "extraction" trouvée pour "${ligne.fournisseur_nom_brut}" dans les ${FENETRE_JOURS} jours précédents.`,
        );
      } else {
        console.log(`  ${candidats.rows.length} facture(s) candidate(s) trouvée(s) :`);
        for (const c of candidats.rows) {
          console.log(`    - document_id=${c.document_id} date=${c.date} ttc=${c.ttc ?? '(null)'}`);
        }
      }

      // < 2 candidates = impossible de former une combinaison de 2 à 4, quel que
      // soit le nombre exact (0 ou 1) : dans les deux cas, la ligne n'est pas
      // testable avec les données actuelles.
      if (candidats.rows.length < 2) {
        console.log(
          `  → Pas assez de factures candidates (${candidats.rows.length}) pour former une combinaison de 2 à 4 : NON TESTABLE avec les données actuelles, pas une infirmation de l'hypothèse.`,
        );
        candidatsInsuffisantsCount += 1;
        continue;
      }

      const target = new Decimal(ligne.debit);
      const matches = findMatchingCombinations(candidats.rows, target);

      if (matches.length === 0) {
        console.log(
          `  → Aucune combinaison de 2 à 4 factures parmi les candidates ne somme à ${target.toFixed(2)} (± ${TOLERANCE.toFixed(2)}).`,
        );
      } else {
        auMoinsUnMatch = true;
        console.log(`  ✓ ${matches.length} combinaison(s) trouvée(s) :`);
        for (const m of matches) {
          const detail = m.factures.map((f) => `document_id=${f.document_id} (ttc=${f.ttc})`).join(' + ');
          console.log(`    - [${m.taille} factures] ${detail} = ${m.somme.toFixed(2)}`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('=== Résumé ===');
    if (auMoinsUnMatch) {
      console.log("Au moins une ligne confirme l'hypothèse (combinaison exacte trouvée).");
    } else if (candidatsInsuffisantsCount === lignesRegroupement.rows.length) {
      console.log(
        `AUCUNE ligne n'a pu être testée : 0 combinaison trouvée pour les ${lignesRegroupement.rows.length} lignes, ` +
          `mais c'est parce qu'il n'y a que ${totalExtraction.rows[0]!.count} ligne(s) dans extraction sur ${totalDocuments.rows[0]!.count} document(s) au total. ` +
          "Ce n'est PAS une infirmation de l'hypothèse — il n'y a simplement pas assez de factures encore traitées par le pipeline pour la tester. " +
          'À relancer une fois le batch complet des 107 documents traité.',
      );
    } else {
      console.log(
        "Hypothèse testée sur les lignes ayant assez de candidates, mais aucune combinaison exacte trouvée. À examiner plus en détail (tolérance, fenêtre de dates, ou matching fournisseur).",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[check-regroupements] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
