import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

const QUEUE_NAME = 'documents';
const SIMULATED_PROCESSING_MS = 1000;

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}
if (!redisUrl) {
  throw new Error('Missing required environment variable: REDIS_URL');
}

const redisConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const pgPool = new Pool({ connectionString: databaseUrl });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processDocumentJob(job: Job<Record<string, unknown>>): Promise<void> {
  console.log(`[worker] Job reçu: id=${job.id} data=${JSON.stringify(job.data)}`);
  await sleep(SIMULATED_PROCESSING_MS);
  console.log(`[worker] Job terminé: id=${job.id}`);
}

const worker = new Worker<Record<string, unknown>>(QUEUE_NAME, processDocumentJob, {
  connection: redisConnection,
});

worker.on('failed', (job, error) => {
  console.error(`[worker] Job échoué: id=${job?.id ?? 'unknown'} error=${error.message}`);
});

worker.on('error', (error) => {
  console.error(`[worker] Erreur worker: ${error.message}`);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[worker] Signal ${signal} reçu, arrêt en cours...`);
  try {
    await worker.close();
    await pgPool.end();
    redisConnection.disconnect();
    console.log('[worker] Arrêt propre terminé');
    process.exit(0);
  } catch (error) {
    console.error('[worker] Erreur pendant l\'arrêt:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

async function start(): Promise<void> {
  await pgPool.query('SELECT 1');
  console.log('[worker] Connexion Postgres OK');
  console.log(`[worker] Worker ready, listening on queue '${QUEUE_NAME}'`);
}

start().catch((error: unknown) => {
  console.error('[worker] Échec du démarrage:', error instanceof Error ? error.message : error);
  process.exit(1);
});
