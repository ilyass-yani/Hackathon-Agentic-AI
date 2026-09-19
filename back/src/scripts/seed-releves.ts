import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

function usageAndExit(): never {
  console.error(
    'Usage: npx tsx src/scripts/seed-releves.ts <chemin-vers-dossier-sujet-03-chiffra>\n' +
      '  Le dossier doit contenir releves/releve-2026-01.csv à releve-2026-06.csv.',
  );
  process.exit(1);
}

const FICHIERS = [
  'releve-2026-01.csv',
  'releve-2026-02.csv',
  'releve-2026-03.csv',
  'releve-2026-04.csv',
  'releve-2026-05.csv',
  'releve-2026-06.csv',
];

interface LigneCsv {
  date: string;
  libelle: string;
  debitMad: string;
  creditMad: string;
  soldeMad: string;
}

function parseCsvRows(content: string): LigneCsv[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [, ...rows] = lines;
  return rows.map((line) => {
    const [date, libelle, debitMad, creditMad, soldeMad] = line.split(',').map((field) => field.trim());
    return { date: date!, libelle: libelle!, debitMad: debitMad!, creditMad: creditMad!, soldeMad: soldeMad! };
  });
}

// Retire un suffixe REGROUPEMENT/ACOMPTE s'il est présent, pour obtenir le nom brut
// du tiers. Utilisé à la fois pour paiement_fournisseur (où le suffixe pilote aussi
// est_regroupement/est_acompte) et pour avoir (où aucun cas de ce genre n'a été vu
// dans l'exploration, mais on nettoie pareil par cohérence si ça arrivait).
function stripKnownSuffix(text: string): string {
  if (text.endsWith(' REGROUPEMENT')) {
    return text.slice(0, -' REGROUPEMENT'.length).trim();
  }
  if (text.endsWith(' ACOMPTE')) {
    return text.slice(0, -' ACOMPTE'.length).trim();
  }
  return text.trim();
}

interface Detection {
  typeDetecte: string | null;
  estRegroupement: boolean;
  estAcompte: boolean;
  fournisseurNomBrut: string | null;
}

// Logique de détection confirmée sur les 111 lignes réelles des 6 CSV explorés au
// préalable — pas une supposition sur le format.
function detecterLigne(libelle: string): Detection {
  const trimmed = libelle.trim();

  if (trimmed === 'VIREMENT SALAIRES') {
    return { typeDetecte: 'salaire', estRegroupement: false, estAcompte: false, fournisseurNomBrut: null };
  }
  if (trimmed === 'FRAIS DE TENUE DE COMPTE') {
    return { typeDetecte: 'frais_bancaire', estRegroupement: false, estAcompte: false, fournisseurNomBrut: null };
  }
  if (trimmed === 'REGLEMENT CLIENT ONCF') {
    return { typeDetecte: 'reglement_client', estRegroupement: false, estAcompte: false, fournisseurNomBrut: null };
  }
  if (trimmed.startsWith('AVOIR ')) {
    return {
      typeDetecte: 'avoir',
      estRegroupement: false,
      estAcompte: false,
      fournisseurNomBrut: stripKnownSuffix(trimmed.slice('AVOIR '.length)),
    };
  }
  if (trimmed.startsWith('VIR ')) {
    const rest = trimmed.slice('VIR '.length);
    return {
      typeDetecte: 'paiement_fournisseur',
      estRegroupement: rest.endsWith(' REGROUPEMENT'),
      estAcompte: rest.endsWith(' ACOMPTE'),
      fournisseurNomBrut: stripKnownSuffix(rest),
    };
  }

  return { typeDetecte: null, estRegroupement: false, estAcompte: false, fournisseurNomBrut: null };
}

async function main(): Promise<void> {
  const dataDir = process.argv[2];
  if (!dataDir) {
    usageAndExit();
  }

  const relevesDir = join(dataDir, 'releves');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const existing = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM releve_ligne');
    const existingCount = Number(existing.rows[0]!.count);
    if (existingCount > 0) {
      console.warn(
        `[seed-releves] ${existingCount} ligne(s) déjà présentes dans releve_ligne — purge avant rechargement (pas d'upsert possible, pas de clé naturelle fiable).`,
      );
    }

    await client.query('BEGIN');
    // DELETE plutôt que TRUNCATE : rapprochement_ligne référence releve_ligne en
    // ON DELETE RESTRICT (piste d'audit, décision déjà prise). TRUNCATE refuse tout
    // net dès qu'une FK référence la table, même vide. DELETE respecte la même
    // philosophie RESTRICT : échoue proprement ligne par ligne si un vrai
    // rapprochement existe un jour, plutôt qu'un TRUNCATE CASCADE qui l'effacerait
    // silencieusement.
    await client.query('DELETE FROM releve_ligne');

    const perFileCounts: Array<{ file: string; count: number }> = [];
    const typeCounts = new Map<string, number>();
    let regroupementCount = 0;
    let acompteCount = 0;
    let nonReconnuCount = 0;
    const fournisseurNomsBruts = new Set<string>();

    for (const fileName of FICHIERS) {
      const content = await readFile(join(relevesDir, fileName), 'utf-8');
      const rows = parseCsvRows(content);

      for (const row of rows) {
        const detection = detecterLigne(row.libelle);

        if (detection.typeDetecte === null) {
          nonReconnuCount += 1;
          console.warn(`[seed-releves] Libellé non reconnu dans ${fileName} : "${row.libelle}"`);
        } else {
          typeCounts.set(detection.typeDetecte, (typeCounts.get(detection.typeDetecte) ?? 0) + 1);
        }
        if (detection.estRegroupement) regroupementCount += 1;
        if (detection.estAcompte) acompteCount += 1;
        if (detection.fournisseurNomBrut) fournisseurNomsBruts.add(detection.fournisseurNomBrut);

        // Le CSV représente le champ inutilisé par "0.0" littéral, jamais vide/NULL
        // (confirmé à l'exploration) : on convertit ça en NULL pour respecter le
        // CHECK "un des deux, jamais les deux" de releve_ligne.
        const debit = Number(row.debitMad) === 0 ? null : row.debitMad;
        const credit = Number(row.creditMad) === 0 ? null : row.creditMad;

        await client.query(
          `INSERT INTO releve_ligne
             (date, libelle, debit, credit, solde, type_detecte, est_regroupement, est_acompte, fournisseur_nom_brut)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            row.date,
            row.libelle,
            debit,
            credit,
            row.soldeMad,
            detection.typeDetecte,
            detection.estRegroupement,
            detection.estAcompte,
            detection.fournisseurNomBrut,
          ],
        );
      }

      perFileCounts.push({ file: fileName, count: rows.length });
    }

    const fournisseurRows = await client.query<{ nom: string }>('SELECT nom FROM fournisseur');
    const fournisseurNoms = new Set(fournisseurRows.rows.map((r) => r.nom));
    const sansMatch = [...fournisseurNomsBruts].filter((nom) => !fournisseurNoms.has(nom)).sort();

    await client.query('COMMIT');

    console.log('=== Lignes chargées par fichier ===');
    let total = 0;
    for (const { file, count } of perFileCounts) {
      console.log(`${file} : ${count}`);
      total += count;
    }
    console.log(`Total : ${total}`);

    console.log('\n=== Répartition par type_detecte ===');
    for (const [type, count] of [...typeCounts.entries()].sort()) {
      console.log(`${type} : ${count}`);
    }
    if (nonReconnuCount > 0) {
      console.log(`NON_RECONNU (type_detecte = NULL) : ${nonReconnuCount}`);
    }

    console.log(`\nest_regroupement : ${regroupementCount}`);
    console.log(`est_acompte : ${acompteCount}`);

    console.log('\n=== Cohérence fournisseur_nom_brut vs table fournisseur ===');
    console.log(`${fournisseurNomsBruts.size} nom(s) brut(s) distinct(s) extraits.`);
    if (sansMatch.length === 0) {
      console.log('✓ Tous matchent exactement un nom de la table fournisseur.');
    } else {
      console.log(`✗ ${sansMatch.length} sans correspondance exacte dans fournisseur :`);
      for (const nom of sansMatch) {
        console.log(`  - "${nom}"`);
      }
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed-releves] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
