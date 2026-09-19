import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

function usageAndExit(): never {
  console.error(
    'Usage: npx tsx src/scripts/seed.ts <chemin-vers-dossier-sujet-03-chiffra>\n' +
      '  Le dossier doit contenir plan-comptable.csv et referentiel-fournisseurs.csv.',
  );
  process.exit(1);
}

interface CompteComptableRow {
  numero: string;
  libelle: string;
}

// taux_tva_habituel / montant_moyen_ttc restent des strings de bout en bout : on ne
// fait jamais passer un montant par un Number() JS avant de l'insérer dans une colonne
// NUMERIC (EX-07 — aucun calcul flottant natif). Postgres parse directement le texte.
interface FournisseurRow {
  nom: string;
  ice: string;
  categorie: string;
  taux_tva_habituel: string;
  compte_comptable: string;
  recurrent: boolean;
  montant_moyen_ttc: string;
}

function parseCsvRows(content: string): string[][] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [, ...rows] = lines;
  return rows.map((line) => line.split(',').map((field) => field.trim()));
}

function parseComptesComptables(content: string): CompteComptableRow[] {
  return parseCsvRows(content).map(([numero, libelle]) => ({ numero: numero!, libelle: libelle! }));
}

function parseRecurrent(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === 'oui') return true;
  if (normalized === 'non') return false;
  throw new Error(`Valeur "recurrent" inattendue : "${value}" (attendu "oui" ou "non")`);
}

function parseFournisseurs(content: string): FournisseurRow[] {
  return parseCsvRows(content).map((fields) => {
    const [fournisseur, ice, categorie, tauxTva, compteComptable, recurrent, montantMoyenTtc] = fields;
    return {
      nom: fournisseur!,
      ice: ice!,
      categorie: categorie!,
      taux_tva_habituel: tauxTva!,
      compte_comptable: compteComptable!,
      recurrent: parseRecurrent(recurrent!),
      montant_moyen_ttc: montantMoyenTtc!,
    };
  });
}

interface UpsertCounts {
  inserted: number;
  updated: number;
}

async function upsertComptesComptables(client: Client, rows: CompteComptableRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0 };
  for (const row of rows) {
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO compte_comptable (numero, libelle)
       VALUES ($1, $2)
       ON CONFLICT (numero) DO UPDATE SET libelle = EXCLUDED.libelle, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [row.numero, row.libelle],
    );
    if (result.rows[0]!.inserted) counts.inserted += 1;
    else counts.updated += 1;
  }
  return counts;
}

async function upsertFournisseurs(client: Client, rows: FournisseurRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0 };
  for (const row of rows) {
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO fournisseur (nom, ice, categorie, taux_tva_habituel, compte_comptable, recurrent, montant_moyen_ttc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ice) DO UPDATE SET
         nom = EXCLUDED.nom,
         categorie = EXCLUDED.categorie,
         taux_tva_habituel = EXCLUDED.taux_tva_habituel,
         compte_comptable = EXCLUDED.compte_comptable,
         recurrent = EXCLUDED.recurrent,
         montant_moyen_ttc = EXCLUDED.montant_moyen_ttc,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        row.nom,
        row.ice,
        row.categorie,
        row.taux_tva_habituel,
        row.compte_comptable,
        row.recurrent,
        row.montant_moyen_ttc,
      ],
    );
    if (result.rows[0]!.inserted) counts.inserted += 1;
    else counts.updated += 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const dataDir = process.argv[2];
  if (!dataDir) {
    usageAndExit();
  }

  const comptesComptablesCsv = await readFile(join(dataDir, 'plan-comptable.csv'), 'utf-8');
  const fournisseursCsv = await readFile(join(dataDir, 'referentiel-fournisseurs.csv'), 'utf-8');

  const comptesComptables = parseComptesComptables(comptesComptablesCsv);
  const fournisseurs = parseFournisseurs(fournisseursCsv);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // plan-comptable.csv avant referentiel-fournisseurs.csv : fournisseur.compte_comptable
    // référence compte_comptable.numero (FK).
    const comptesResult = await upsertComptesComptables(client, comptesComptables);
    const fournisseursResult = await upsertFournisseurs(client, fournisseurs);

    // Confirmation explicite (garantie par la FK, mais vérifiée en clair comme demandé).
    const orphans = await client.query<{ compte_comptable: string }>(
      `SELECT DISTINCT f.compte_comptable
       FROM fournisseur f
       LEFT JOIN compte_comptable c ON c.numero = f.compte_comptable
       WHERE c.numero IS NULL`,
    );

    await client.query('COMMIT');

    console.log('=== Seed terminé ===');
    console.log(`compte_comptable : ${comptesResult.inserted} insérés, ${comptesResult.updated} mis à jour`);
    console.log(`fournisseur      : ${fournisseursResult.inserted} insérés, ${fournisseursResult.updated} mis à jour`);
    console.log('');
    if (orphans.rows.length === 0) {
      console.log('✓ Cohérence : tous les compte_comptable référencés par fournisseur existent dans compte_comptable.');
    } else {
      console.log(`✗ PROBLÈME : ${orphans.rows.length} compte_comptable référencés par fournisseur sont absents :`);
      for (const row of orphans.rows) {
        console.log(`  - ${row.compte_comptable}`);
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
  console.error('[seed] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
