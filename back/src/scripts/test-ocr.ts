import { config } from 'dotenv';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraireDocument, verifierCoherenceMontants, type ExtractedInvoice, type StatutExtraction } from '../lib/extraction.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg']);
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const OCR_RESULTS_DIR = resolve(scriptDir, 'ocr-results');

interface ProcessResult {
  file: string;
  statut: StatutExtraction;
  motif?: string;
  score_nettete: number;
  nombre_appels_llm: 0 | 1 | 2;
  extraction: ExtractedInvoice | null;
  extractions_brutes?: [ExtractedInvoice, ExtractedInvoice];
  confiance: number | null;
  coherent: boolean | null;
  processingMs: number;
}

function usageAndExit(): never {
  console.error(
    "Usage: npx tsx src/scripts/test-ocr.ts <chemin-vers-fichier-ou-dossier>\n" +
      '  - fichier : traite un seul PDF ou JPG\n' +
      '  - dossier : traite tous les PDF/JPG du dossier et affiche un résumé',
  );
  process.exit(1);
}

async function processFile(filePath: string): Promise<ProcessResult> {
  const start = performance.now();
  const fileName = basename(filePath);
  const resultat = await extraireDocument(filePath);
  const processingMs = performance.now() - start;

  const coherent = resultat.extraction ? verifierCoherenceMontants(resultat.extraction) : null;
  if (coherent === false && resultat.extraction) {
    console.warn(
      `[test-ocr] Incohérence HT + TVA != TTC pour ${filePath}: ht=${resultat.extraction.ht} tva=${resultat.extraction.tva} ttc=${resultat.extraction.ttc}`,
    );
  }

  const extractionsBrutes: [ExtractedInvoice, ExtractedInvoice] | undefined =
    resultat.extraction && resultat.extractionAlternative
      ? [resultat.extraction, resultat.extractionAlternative]
      : undefined;

  const result: ProcessResult = {
    file: fileName,
    statut: resultat.statut,
    score_nettete: resultat.scoreNettete,
    nombre_appels_llm: resultat.nombreAppelsLlm,
    extraction: resultat.extraction,
    confiance: resultat.extraction?.confiance ?? null,
    coherent,
    processingMs,
  };
  if (resultat.motif !== null) {
    result.motif = resultat.motif;
  }
  if (extractionsBrutes) {
    result.extractions_brutes = extractionsBrutes;
  }
  return result;
}

async function saveBatchResults(results: ProcessResult[]): Promise<string> {
  await mkdir(OCR_RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OCR_RESULTS_DIR, `run-${timestamp}.json`);
  await writeFile(outPath, JSON.stringify(results, null, 2), 'utf-8');
  return outPath;
}

async function listCandidateFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dirPath, entry.name))
    .sort();
}

async function main(): Promise<void> {
  const targetPath = process.argv[2];
  if (!targetPath) {
    usageAndExit();
  }

  const stats = await stat(targetPath);

  if (stats.isDirectory()) {
    const files = await listCandidateFiles(targetPath);
    if (files.length === 0) {
      console.error(`[test-ocr] Aucun fichier PDF/JPG trouvé dans ${targetPath}`);
      process.exit(1);
    }

    let lowConfidenceCount = 0;
    let incoherentCount = 0;
    const statutCounts: Record<StatutExtraction, number> = { traite: 0, a_verifier: 0, non_traite: 0 };
    const results: ProcessResult[] = [];

    for (const file of files) {
      try {
        const result = await processFile(file);
        console.log(JSON.stringify(result, null, 2));
        results.push(result);
        statutCounts[result.statut] += 1;
        if (result.confiance !== null && result.confiance < LOW_CONFIDENCE_THRESHOLD) {
          lowConfidenceCount += 1;
        }
        if (result.coherent === false) {
          incoherentCount += 1;
        }
      } catch (error) {
        console.error(`[test-ocr] Échec sur ${file}:`, error instanceof Error ? error.message : error);
      }
    }

    const outPath = await saveBatchResults(results);

    console.log('\n=== Résumé batch ===');
    console.log(`Fichiers traités : ${files.length}`);
    console.log(`  - traite : ${statutCounts.traite}`);
    console.log(`  - a_verifier : ${statutCounts.a_verifier}`);
    console.log(`  - non_traite : ${statutCounts.non_traite}`);
    console.log(`Confiance basse (< ${LOW_CONFIDENCE_THRESHOLD}) : ${lowConfidenceCount}`);
    console.log(`Incohérences HT/TVA/TTC détectées : ${incoherentCount}`);
    console.log(`Détail sauvegardé dans : ${outPath}`);
    return;
  }

  const result = await processFile(targetPath);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('[test-ocr] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
