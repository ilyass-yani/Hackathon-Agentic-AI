import 'dotenv/config';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';

const PORT = 3000;
const HOST = '0.0.0.0';
const QUEUE_NAME = 'documents';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}
if (!redisUrl) {
  throw new Error('Missing required environment variable: REDIS_URL');
}

const fastify = Fastify({ logger: true });

const pgPool = new Pool({ connectionString: databaseUrl });
const redisConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const documentsQueue = new Queue(QUEUE_NAME, { connection: redisConnection });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

fastify.get('/health', async () => {
  return { status: 'ok' };
});

fastify.get('/health/db', async (_request, reply) => {
  try {
    await pgPool.query('SELECT 1');
    return { status: 'ok' };
  } catch (error) {
    fastify.log.error(error, 'Postgres health check failed');
    return reply.code(500).send({ status: 'error', message: errorMessage(error) });
  }
});

fastify.get('/health/redis', async (_request, reply) => {
  try {
    await redisConnection.ping();
    return { status: 'ok' };
  } catch (error) {
    fastify.log.error(error, 'Redis health check failed');
    return reply.code(500).send({ status: 'error', message: errorMessage(error) });
  }
});

fastify.get('/health/queue', async (_request, reply) => {
  try {
    const counts = await documentsQueue.getJobCounts();
    return { status: 'ok', queue: QUEUE_NAME, counts };
  } catch (error) {
    fastify.log.error(error, 'Queue health check failed');
    return reply.code(500).send({ status: 'error', message: errorMessage(error) });
  }
});

fastify.listen({ port: PORT, host: HOST }, (error) => {
  if (error) {
    fastify.log.error(error, 'Failed to start API server');
    process.exit(1);
  }
  fastify.log.info(`API listening on ${HOST}:${PORT}`);
});
