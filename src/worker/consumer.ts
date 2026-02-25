process.env.LOG_FILE = process.env.LOG_FILE || 'worker.log';

import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';
import { connectDatabase } from '../services/database';
import { Task, TaskStatus } from '../models/Task';
import type { CrawlJobData } from '../services/queue';
import { createCrawler } from './crawler';
import { createLogger } from '../utils/logger';

const logger = createLogger('worker:consumer');

const QUEUE_NAME = 'crawl-tasks';

async function processJob(job: Job<CrawlJobData>): Promise<void> {
  const { taskId, urls, options } = job.data;
  logger.info({ taskId, urls: urls.length }, 'Processing crawl job');

  // Update task status to RUNNING
  await Task.updateOne(
    { taskId },
    { $set: { status: TaskStatus.RUNNING, startedAt: new Date() } }
  );

  try {
    const crawler = createCrawler(taskId, options);
    await crawler.run(urls);

    // Mark as COMPLETED
    await Task.updateOne(
      { taskId },
      { $set: { status: TaskStatus.COMPLETED, completedAt: new Date() } }
    );

    logger.info({ taskId }, 'Crawl job completed');
  } catch (error) {
    const errorMessage = (error as Error).message;
    logger.error({ taskId, error: errorMessage }, 'Crawl job failed');

    // Mark as FAILED
    await Task.updateOne(
      { taskId },
      {
        $set: {
          status: TaskStatus.FAILED,
          completedAt: new Date(),
          errorMessage,
        },
      }
    );

    throw error;
  }
}

async function main(): Promise<void> {
  logger.info('Starting worker...');

  // Connect to MongoDB
  await connectDatabase();

  // Create Redis connection for BullMQ Worker
  const connection = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  // Create BullMQ Worker
  const worker = new Worker<CrawlJobData>(QUEUE_NAME, processJob, {
    connection,
    concurrency: 1, // One crawl task at a time; Crawlee handles page-level concurrency
    lockDuration: 300000, // 5 minutes - crawl tasks can take a while
    stalledInterval: 300000,
  });

  // Event handlers
  worker.on('active', (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, 'Job active');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, taskId: job?.data.taskId, error: error.message },
      'Job failed'
    );
  });

  worker.on('error', (error) => {
    logger.error({ error: error.message }, 'Worker error');
  });

  logger.info('Worker started, waiting for jobs...');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await worker.close();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run directly
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error: error.message }, 'Worker startup failed');
    process.exit(1);
  });
}

export { main };
