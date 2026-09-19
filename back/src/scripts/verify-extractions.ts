import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-06-30';
const ICE_FORMAT = /^\d{15}$/;

type FlagType =
  | 'tiers_inconnu'
  | 'taux_tva_suspect'
  | 'date_hors_periode'
  | 'incoherence_montants'
  | 'format_ice_invalide';

interface ExtractedInvoice {
  tiers: string | null;
  date: string | null;
  ht: number | null;
  tva: number | null;
  taux_tva: number | null;
  ttc: number | null;
  numero_piece: string | null;
  ice_fournisseur: string | null;
  ice_client: string | null;
  confiance: number | null;
}

interface ProcessResult {
  file: string;
  extraction: ExtractedInvoice;
  confiance: number | null;
  coherent: boolean | null;
  processingMs: number;
}

interface ReferentielFournisseur {
  fournisseur: string;
  ice: string;
  categorie: string;
  taux_tva_habituel: number;
  compte_comptable: string;
  recurrent: string;
  montant_moyen_ttc_mad: number;
}

interface FlaggedResult {
  result: ProcessResult;
  flags: FlagType[];
}

function usageAndExit(): never {
  console.error(
    'Usage: npx tsx src/scripts/verify-extractions.ts <chemin-vers-run-json> <chemin-vers-referentiel-fournisseurs.csv>',
  );
  process.exit(1);
}

function normalizeIce(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\D/g, '');
}

function parseCsv(content: string): ReferentielFournisseur[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [, ...rows] = lines;
  return rows.map((line) => {
    const [fournisseur, ice, categorie, taux_tva_habituel, compte_comptable, recurrent, montant_moyen_ttc_mad] =
      line.split(',');
    return {
      fournisseur,
      ice,
      categorie,
      taux_tva_habituel: Number(taux_tva_habituel),
      compte_comptable,
      recurrent,
      montant_moyen_ttc_mad: Number(montant_moyen_ttc_mad),
    };
  });
}

function verifyExtraction(
  result: ProcessResult,
  referentiel: Map<string, ReferentielFournisseur>,
): FlagType[] {
  const flags: FlagType[] = [];
  const { extraction, coherent } = result;

  const fournisseurConnu =
    extraction.ice_fournisseur !== null ? referentiel.get(normalizeIce(extraction.ice_fournisseur)) : undefined;

  if (extraction.ice_fournisseur !== null && !fournisseurConnu) {
    flags.push('tiers_inconnu');
  }

  if (fournisseurConnu && extraction.taux_tva !== null && extraction.taux_tva !== fournisseurConnu.taux_tva_habituel) {
    flags.push('taux_tva_suspect');
  }

  if (extraction.date !== null && (extraction.date < PERIOD_START || extraction.date > PERIOD_END)) {
    flags.push('date_hors_periode');
  }

  if (coherent === false) {
    flags.push('incoherence_montants');
  }

  if (extraction.ice_fournisseur !== null && !ICE_FORMAT.test(extraction.ice_fournisseur)) {
    flags.push('format_ice_invalide');
  }

  return flags;
}

function formatExtraction(extraction: ExtractedInvoice): string {
  return [
    `  - tiers: ${extraction.tiers ?? 'null'}`,
    `  - date: ${extraction.date ?? 'null'}`,
    `  - ht: ${extraction.ht ?? 'null'}`,
    `  - tva: ${extraction.tva ?? 'null'}`,
    `  - taux_tva: ${extraction.taux_tva ?? 'null'}`,
    `  - ttc: ${extraction.ttc ?? 'null'}`,
    `  - numero_piece: ${extraction.numero_piece ?? 'null'}`,
    `  - ice_fournisseur: ${extraction.ice_fournisseur ?? 'null'}`,
    `  - ice_client: ${extraction.ice_client ?? 'null'}`,
    `  - confiance: ${extraction.confiance ?? 'null'}`,
  ].join('\n');
}

function buildReport(results: ProcessResult[], flaggedResults: FlaggedResult[]): string {
  const flagCounts = new Map<FlagType, number>();
  for (const { flags } of flaggedResults) {
    for (const flag of flags) {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    }
  }

  const priorityReview = flaggedResults.filter(({ flags }) => flags.length >= 2);

  const lines: string[] = [];
  lines.push('# Rapport de vérification des extractions OCR');
  lines.push('');
  lines.push(`- Documents traités : ${results.length}`);
  lines.push(`- Documents avec au moins un flag : ${flaggedResults.length}`);
  lines.push('');
  lines.push('## Répartition par type de flag');
  lines.push('');
  if (flagCounts.size === 0) {
    lines.push('Aucun flag détecté.');
  } else {
    for (const [flag, count] of flagCounts) {
      lines.push(`- ${flag} : ${count}`);
    }
  }
  lines.push('');
  lines.push('## Documents flaggés');
  lines.push('');
  if (flaggedResults.length === 0) {
    lines.push('Aucun document flaggé.');
  } else {
    for (const { result, flags } of flaggedResults) {
      lines.push(`### ${result.file}`);
      lines.push('');
      lines.push(`Flags : ${flags.join(', ')}`);
      lines.push('');
      lines.push('Extraction :');
      lines.push('');
      lines.push(formatExtraction(result.extraction));
      lines.push('');
    }
  }
  lines.push('## À vérifier manuellement en priorité (2+ flags simultanés)');
  lines.push('');
  if (priorityReview.length === 0) {
    lines.push('Aucun document avec plusieurs flags simultanés.');
  } else {
    for (const { result, flags } of priorityReview) {
      lines.push(`### ${result.file}`);
      lines.push('');
      lines.push(`Flags : ${flags.join(', ')}`);
      lines.push('');
      lines.push('Extraction :');
      lines.push('');
      lines.push(formatExtraction(result.extraction));
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const jsonPath = process.argv[2];
  const csvPath = process.argv[3];
  if (!jsonPath || !csvPath) {
    usageAndExit();
  }

  const resultsRaw = await readFile(resolve(jsonPath), 'utf-8');
  const results = JSON.parse(resultsRaw) as ProcessResult[];

  const csvRaw = await readFile(resolve(csvPath), 'utf-8');
  const referentielList = parseCsv(csvRaw);
  const referentiel = new Map(referentielList.map((entry) => [normalizeIce(entry.ice), entry]));

  const flaggedResults: FlaggedResult[] = [];
  for (const result of results) {
    const flags = verifyExtraction(result, referentiel);
    if (flags.length > 0) {
      flaggedResults.push({ result, flags });
    }
  }

  const report = buildReport(results, flaggedResults);

  console.log(report);

  const outDir = resolve(scriptDir, 'ocr-results');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, 'rapport-verification.md');
  await writeFile(outPath, report, 'utf-8');
  console.log(`\n[verify-extractions] Rapport sauvegardé dans : ${outPath}`);
}

main().catch((error: unknown) => {
  console.error('[verify-extractions] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
