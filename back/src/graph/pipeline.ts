import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const scriptDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(scriptDir, '../../../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

export const PipelineState = Annotation.Root({
  documentId: Annotation<number>,
  cheminFichier: Annotation<string>,
  statut: Annotation<string>,
  extraction: Annotation<Record<string, unknown> | null>,
  motifEchec: Annotation<string | null>,
  anomalies: Annotation<unknown[]>,
  erreurs: Annotation<string[]>,
});

// Placeholder : ne fait aucun vrai traitement, juste la preuve que le nœud s'exécute
// et que le state se propage. Le vrai Ingestor (test-ocr.ts) sera branché plus tard.
async function ingestorPlaceholder(
  state: typeof PipelineState.State,
): Promise<Partial<typeof PipelineState.State>> {
  console.log(`Node ingestor_placeholder: document ${state.documentId}`);
  return { statut: 'traite' };
}

const graph = new StateGraph(PipelineState)
  .addNode('ingestor_placeholder', ingestorPlaceholder)
  .addEdge(START, 'ingestor_placeholder')
  .addEdge('ingestor_placeholder', END);

async function buildCheckpointedGraph(): Promise<{ app: ReturnType<typeof graph.compile>; checkpointer: PostgresSaver }> {
  // PostgresSaver a besoin de ses propres tables internes (checkpoints,
  // checkpoint_writes, checkpoint_blobs, ...). setup() les crée/migre
  // automatiquement (méthode recommandée par le package) : pas de migration
  // node-pg-migrate à écrire à la main pour ça.
  const checkpointer = PostgresSaver.fromConnString(DATABASE_URL as string);
  await checkpointer.setup();
  return { app: graph.compile({ checkpointer }), checkpointer };
}

// Un seul Pool/checkpointer pour tout le process en usage normal : on compile le
// graphe une fois, paresseusement, et on réutilise l'instance pour tous les appels.
let current: Promise<{ app: ReturnType<typeof graph.compile>; checkpointer: PostgresSaver }> | null = null;

function getCompiledGraph() {
  if (!current) {
    current = buildCheckpointedGraph();
  }
  return current;
}

// Réservé au test de résilience (test-graph.ts) : construit un TOUT NOUVEAU
// checkpointer/pool, indépendant de celui utilisé par runPipeline(), comme le
// ferait un worker qui redémarre à froid.
export async function buildFreshApp() {
  return buildCheckpointedGraph();
}

// Réservé au test de résilience : ferme la connexion du checkpointer actuellement
// utilisé par runPipeline() et force la reconstruction d'un nouveau au prochain appel.
export async function closePipelineConnection(): Promise<void> {
  if (!current) {
    return;
  }
  const { checkpointer } = await current;
  await checkpointer.end();
  current = null;
}

export async function runPipeline(documentId: number, cheminFichier: string): Promise<typeof PipelineState.State> {
  const { app } = await getCompiledGraph();

  const initialState: typeof PipelineState.State = {
    documentId,
    cheminFichier,
    statut: 'en_attente',
    extraction: null,
    motifEchec: null,
    anomalies: [],
    erreurs: [],
  };

  // thread_id = identité de la conversation/exécution pour le checkpointer : un
  // document = un thread, pour pouvoir reprendre/consulter son historique plus tard.
  return app.invoke(initialState, { configurable: { thread_id: `document-${documentId}` } });
}
