import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type ImageData } from '@napi-rs/canvas';
import { Decimal } from 'decimal.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Module autonome : charge son propre .env plutôt que de dépendre de l'ordre
// d'exécution de l'appelant (les imports ESM sont évalués avant le reste du corps
// du module importateur, donc un config() fait par l'appelant peut arriver trop tard).
const libDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(libDir, '../../../.env') });

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

const COHERENCE_TOLERANCE = new Decimal('0.01');
const PDF_RENDER_SCALE = 2;

// Score de netteté = variance du Laplacien sur l'image en niveaux de gris, calculée
// uniquement sur la zone de contenu (bounding box des pixels non-blancs) et non sur
// l'image entière : une page peu dense en texte (beaucoup de blanc) aurait sinon une
// variance globale basse même si le texte présent est net, indistinguable d'une page
// dont le texte est réellement flou. Restreindre au contenu isole la vraie netteté du
// texte de la simple densité de la page.
// - Sous SEUIL_NETTETE_BAS : image manifestement illisible, rejet direct sans appeler le LLM.
// - Entre les deux seuils : zone grise, on ne peut pas trancher sur la seule netteté ->
//   double lecture LLM pour vérifier la stabilité de l'extraction.
// - Au-dessus de SEUIL_NETTETE_HAUT : image nette, un seul appel LLM suffit.
// Valeurs calibrées empiriquement sur les 107 factures du corpus de test ; à réajuster
// si de nouveaux types de documents entrent dans le pipeline.
const SEUIL_NETTETE_BAS = 20;
const SEUIL_NETTETE_HAUT = 400;

// Un pixel est considéré comme "contenu" (texte/encre) s'il est plus sombre que ce
// seuil de luminosité (0-255) ; au-dessus, il est traité comme fond de page blanc.
const CONTENT_LUMINOSITY_THRESHOLD = 245;

// Divergence "montant" entre deux lectures : écart relatif sur le TTC au-delà duquel
// on considère que les deux lectures ne s'accordent pas.
const MONTANT_DIVERGENCE_TOLERANCE = 0.01;

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

// Noms de champs en snake_case : correspond exactement au contrat JSON du LLM
// (SYSTEM_PROMPT ci-dessus) et aux colonnes de la table extraction en base — aucun
// remappage nécessaire à l'écriture Postgres.
export interface ExtractedInvoice {
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

export type StatutExtraction = 'traite' | 'a_verifier' | 'non_traite';

export interface ResultatExtraction {
  statut: StatutExtraction;
  motif: string | null;
  extraction: ExtractedInvoice | null;
  extractionAlternative: ExtractedInvoice | null;
  scoreNettete: number;
  nombreAppelsLlm: 0 | 1 | 2;
}

interface DocumentImage {
  dataUrl: string;
  imageData: ImageData;
}

async function loadDocumentImage(filePath: string): Promise<DocumentImage> {
  const ext = extname(filePath).toLowerCase();
  const raw = await readFile(filePath);

  if (ext === '.pdf') {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(raw) }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const png = canvas.toBuffer('image/png');
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, imageData };
  }

  const image = await loadImage(raw);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return { dataUrl: `data:image/jpeg;base64,${raw.toString('base64')}`, imageData };
}

interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function computeContentBoundingBox(gray: Float64Array, width: number, height: number): BoundingBox {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x]! < CONTENT_LUMINOSITY_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    // Aucun pixel de contenu détecté (page blanche) : on retombe sur l'image entière.
    return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function computeSharpnessScore(imageData: ImageData): number {
  const { data, width, height } = imageData;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const box = computeContentBoundingBox(gray, width, height);

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = Math.max(box.y0, 1); y < Math.min(box.y1 + 1, height - 1); y += 1) {
    for (let x = Math.max(box.x0, 1); x < Math.min(box.x1 + 1, width - 1); x += 1) {
      const idx = y * width + x;
      const laplacian =
        -4 * gray[idx]! + gray[idx - 1]! + gray[idx + 1]! + gray[idx - width]! + gray[idx + width]!;
      sum += laplacian;
      sumSq += laplacian * laplacian;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }

  const mean = sum / count;
  return sumSq / count - mean * mean;
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

// Toute erreur ici (timeout, rate limit, HTTP non-ok, réponse malformée) remonte
// comme une vraie exception JS — jamais convertie en statut métier. C'est un problème
// technique (réseau/API), pas un jugement sur le contenu du document.
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

// Vérification HT + TVA = TTC (pas un statut en soi, juste un signal exposé pour les
// scripts/nœuds appelants qui veulent le logger ou le croiser plus tard).
export function verifierCoherenceMontants(extraction: ExtractedInvoice): boolean | null {
  if (extraction.ht === null || extraction.tva === null || extraction.ttc === null) {
    return null;
  }
  const sum = new Decimal(extraction.ht).plus(extraction.tva);
  const diff = sum.minus(extraction.ttc).abs();
  return diff.lessThanOrEqualTo(COHERENCE_TOLERANCE);
}

function normalizeText(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function textDiffers(a: string | null, b: string | null): boolean {
  if (a === null && b === null) {
    return false;
  }
  if (a === null || b === null) {
    return true;
  }
  return normalizeText(a) !== normalizeText(b);
}

function montantDiffers(a: number | null, b: number | null): boolean {
  if (a === null && b === null) {
    return false;
  }
  if (a === null || b === null) {
    return true;
  }
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom > MONTANT_DIVERGENCE_TOLERANCE;
}

type Divergence = 'total' | 'partial' | 'none';

function compareExtractions(a: ExtractedInvoice, b: ExtractedInvoice): Divergence {
  const tiersDiff = textDiffers(a.tiers, b.tiers);
  const montantDiff = montantDiffers(a.ttc, b.ttc);
  const numeroDiff = textDiffers(a.numero_piece, b.numero_piece);

  if (tiersDiff && montantDiff && numeroDiff) {
    return 'total';
  }
  if (tiersDiff || montantDiff || numeroDiff) {
    return 'partial';
  }
  return 'none';
}

// Logique métier complète d'extraction d'une facture : rasterisation, score de
// netteté, appel(s) LLM, comparaison double lecture, décision traite/a_verifier/
// non_traite. NE TOUCHE PAS à Postgres — retourne juste un résultat. Les erreurs
// réseau/API ne sont jamais catchées ici : elles remontent telles quelles (cf.
// callVisionExtraction), à charge de l'appelant de décider retry ou pas.
export async function extraireDocument(cheminFichier: string): Promise<ResultatExtraction> {
  const { dataUrl, imageData } = await loadDocumentImage(cheminFichier);
  const scoreNettete = computeSharpnessScore(imageData);

  if (scoreNettete < SEUIL_NETTETE_BAS) {
    return {
      statut: 'non_traite',
      motif: `image trop dégradée (score netteté: ${scoreNettete.toFixed(1)})`,
      extraction: null,
      extractionAlternative: null,
      scoreNettete,
      nombreAppelsLlm: 0,
    };
  }

  if (scoreNettete <= SEUIL_NETTETE_HAUT) {
    const [extraction1, extraction2] = await Promise.all([
      callVisionExtraction(dataUrl),
      callVisionExtraction(dataUrl),
    ]);
    const divergence = compareExtractions(extraction1, extraction2);

    if (divergence === 'total') {
      return {
        statut: 'non_traite',
        motif: 'lectures incohérentes entre deux tentatives, aucune valeur fiable',
        extraction: null,
        extractionAlternative: extraction2,
        scoreNettete,
        nombreAppelsLlm: 2,
      };
    }

    if (divergence === 'partial') {
      return {
        statut: 'a_verifier',
        motif: 'lectures partiellement divergentes entre deux tentatives, revue humaine requise',
        extraction: extraction1,
        extractionAlternative: extraction2,
        scoreNettete,
        nombreAppelsLlm: 2,
      };
    }

    return {
      statut: 'traite',
      motif: null,
      extraction: extraction1,
      extractionAlternative: extraction2,
      scoreNettete,
      nombreAppelsLlm: 2,
    };
  }

  const extraction = await callVisionExtraction(dataUrl);
  return {
    statut: 'traite',
    motif: null,
    extraction,
    extractionAlternative: null,
    scoreNettete,
    nombreAppelsLlm: 1,
  };
}
