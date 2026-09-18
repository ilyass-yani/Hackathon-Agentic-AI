import { config } from 'dotenv';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { Decimal } from 'decimal.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION;
const AZURE_OPENAI_DEPLOYMENT_NAME = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

if (!AZURE_OPENAI_ENDPOINT) {
  throw new Error('Missing required environment variable: AZURE_OPENAI_ENDPOINT');
}
if (!AZURE_OPENAI_API_KEY) {
  throw new Error('Missing required environment variable: AZURE_OPENAI_API_KEY');
}
if (!AZURE_OPENAI_API_VERSION) {
  throw new Error('Missing required environment variable: AZURE_OPENAI_API_VERSION');
}
if (!AZURE_OPENAI_DEPLOYMENT_NAME) {
  throw new Error('Missing required environment variable: AZURE_OPENAI_DEPLOYMENT_NAME');
}

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg']);
const LOW_CONFIDENCE_THRESHOLD = 0.7;
const COHERENCE_TOLERANCE = new Decimal('0.01');
const PDF_RENDER_SCALE = 2;

const SYSTEM_PROMPT = `Tu es un extracteur de données de factures marocaines. Tu reçois l'image d'une facture et tu dois répondre UNIQUEMENT avec un objet JSON strict contenant exactement ces champs :
- tiers (string ou null) : nom du fournisseur
- date (string ISO "YYYY-MM-DD" ou null) : date de la facture
- ht (number ou null) : montant hors taxes
- tva (number ou null) : montant de la TVA
- taux_tva (number ou null) : taux de TVA en pourcentage (ex: 20)
- ttc (number ou null) : montant total toutes taxes comprises
- numero_piece (string ou null) : numéro de la facture
- ice_fournisseur (string ou null) : ICE du fournisseur
- ice_client (string ou null) : ICE du client
- confiance (number entre 0 et 1) : ton estimation de la fiabilité de ta propre lecture

RÈGLE ABSOLUE : si un champ n'est pas lisible ou absent du document, tu mets null. Tu n'inventes JAMAIS une valeur, un montant ou une date. Halluciner une donnée est une erreur grave.
Réponds uniquement avec le JSON, sans texte autour ni bloc de code.`;

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

async function renderPdfFirstPageToPng(pdfBuffer: Buffer): Promise<Buffer> {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');
  await page.render({
    canvas: null,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return canvas.toBuffer('image/png');
}

async function fileToImageDataUrl(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const raw = await readFile(filePath);

  if (ext === '.pdf') {
    const png = await renderPdfFirstPageToPng(raw);
    return `data:image/png;base64,${png.toString('base64')}`;
  }
  return `data:image/jpeg;base64,${raw.toString('base64')}`;
}

function isExtractedInvoice(value: unknown): value is ExtractedInvoice {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const requiredKeys = [
    'tiers',
    'date',
    'ht',
    'tva',
    'taux_tva',
    'ttc',
    'numero_piece',
    'ice_fournisseur',
    'ice_client',
    'confiance',
  ];
  return requiredKeys.every((key) => key in value);
}

async function callVisionExtraction(imageDataUrl: string): Promise<ExtractedInvoice> {
  const url = `${AZURE_OPENAI_ENDPOINT}openai/deployments/${AZURE_OPENAI_DEPLOYMENT_NAME}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': AZURE_OPENAI_API_KEY as string,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extrais les données de cette facture au format JSON demandé.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Appel LLM échoué (HTTP ${response.status}): ${errorBody}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Réponse du LLM vide ou mal formée');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Le LLM n'a pas renvoyé un JSON valide: ${content}`);
  }

  if (!isExtractedInvoice(parsed)) {
    throw new Error(`JSON renvoyé incomplet par rapport au schéma attendu: ${content}`);
  }

  return parsed;
}

function checkCoherence(extraction: ExtractedInvoice): boolean | null {
  if (extraction.ht === null || extraction.tva === null || extraction.ttc === null) {
    return null;
  }
  const sum = new Decimal(extraction.ht).plus(extraction.tva);
  const diff = sum.minus(extraction.ttc).abs();
  return diff.lessThanOrEqualTo(COHERENCE_TOLERANCE);
}

async function processFile(filePath: string): Promise<ProcessResult> {
  const start = performance.now();
  const imageDataUrl = await fileToImageDataUrl(filePath);
  const extraction = await callVisionExtraction(imageDataUrl);
  const coherent = checkCoherence(extraction);
  const processingMs = performance.now() - start;

  if (coherent === false) {
    console.warn(
      `[test-ocr] Incohérence HT + TVA != TTC pour ${filePath}: ht=${extraction.ht} tva=${extraction.tva} ttc=${extraction.ttc}`,
    );
  }

  return { file: filePath, extraction, coherent, processingMs };
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

    for (const file of files) {
      try {
        const result = await processFile(file);
        console.log(JSON.stringify(result, null, 2));
        if (result.extraction.confiance !== null && result.extraction.confiance < LOW_CONFIDENCE_THRESHOLD) {
          lowConfidenceCount += 1;
        }
        if (result.coherent === false) {
          incoherentCount += 1;
        }
      } catch (error) {
        console.error(`[test-ocr] Échec sur ${file}:`, error instanceof Error ? error.message : error);
      }
    }

    console.log('\n=== Résumé batch ===');
    console.log(`Fichiers traités : ${files.length}`);
    console.log(`Confiance basse (< ${LOW_CONFIDENCE_THRESHOLD}) : ${lowConfidenceCount}`);
    console.log(`Incohérences HT/TVA/TTC détectées : ${incoherentCount}`);
    return;
  }

  const result = await processFile(targetPath);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('[test-ocr] Erreur fatale:', error instanceof Error ? error.message : error);
  process.exit(1);
});
