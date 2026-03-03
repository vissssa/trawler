process.env.LOG_FILE = process.env.LOG_FILE || 'worker.log';

import { Worker, Job } from 'bullmq';
import { rm } from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { connectDatabase, disconnectDatabase } from '../services/database';
import { Task, TaskStatus } from '../models/Task';
import type { CrawlJobData } from '../services/queue';
import { createCrawler } from './crawler';
import { createLogger } from '../utils/logger';
import { createRedisConnection, getBullMQPrefix } from '../services/redis';

const logger = createLogger('worker:consumer');

const QUEUE_NAME = 'crawl-tasks';

async function processJob(job: Job<CrawlJobData>): Promise<void> {
  const { taskId, urls, options } = job.data;
  logger.info({ taskId, urls: urls.length, attempt: job.attemptsMade + 1 }, 'Processing crawl job');

  // On retry, clean up disk files and reset progress/result to avoid duplicate accumulation
  if (job.attemptsMade > 0) {
    const taskDir = path.join(config.storage.dataDir, taskId);
    await rm(taskDir, { recursive: true, force: true }).catch(() => {});

    await Task.updateOne(
      { taskId },
      {
        $set: {
          status: TaskStatus.RUNNING,
          progress: { completed: 0, total: urls.length, failed: 0, currentUrl: '' },
          result: { files: [], errors: [], stats: { success: 0, failed: 0, skipped: 0 } },
        },
      }
    );
  } else {
    // First attempt: set status to RUNNING
    await Task.updateOne(
      { taskId },
      { $set: { status: TaskStatus.RUNNING, startedAt: new Date() } }
    );
  }

  try {
    const crawler = createCrawler(taskId, options);
    await crawler.run(urls);

    // Check if there were failures during crawl
    const task = await Task.findOne({ taskId }, 'progress');
    const failedCount = task?.progress?.failed || 0;
    const completedCount = task?.progress?.completed || 0;

    if (completedCount === 0 && failedCount > 0) {
      // All pages failed
      await Task.updateOne(
        { taskId },
        {
          $set: {
            status: TaskStatus.FAILED,
            completedAt: new Date(),
            errorMessage: `All ${failedCount} pages failed`,
          },
        }
      );
    } else {
      await Task.updateOne(
        { taskId },
        { $set: { status: TaskStatus.COMPLETED, completedAt: new Date() } }
      );
    }

    logger.info({ taskId, completedCount, failedCount }, 'Crawl job completed');
  } catch (error) {
    const errorMessage = (error as Error).message;
    logger.error({ taskId, error: errorMessage, attempt: job.attemptsMade + 1 }, 'Crawl job failed');

    const maxAttempts = (job.opts?.attempts ?? 1);
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

    if (isFinalAttempt) {
      // Only mark FAILED on the final attempt
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
    }

    throw error;
  } finally {
    // Clean up Crawlee temporary storage
    await rm(`/tmp/crawlee-${taskId}`, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  logger.info('Starting worker...');

  // Connect to MongoDB
  await connectDatabase();

  // Create Redis connection for BullMQ Worker
  const connection = createRedisConnection({ maxRetriesPerRequest: null });

  // Create BullMQ Worker
  const worker = new Worker<CrawlJobData>(QUEUE_NAME, processJob, {
    connection,
    prefix: getBullMQPrefix(),
    concurrency: 1, // One crawl task at a time; Crawlee handles page-level concurrency
    lockDuration: 300000, // 5 minutes - crawl tasks can take a while
    stalledInterval: 600000, // 2x lockDuration to avoid false stalled detection
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
      { jobId: job?.id, taskId: job?.data?.taskId, error: error.message },
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
    await disconnectDatabase();
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

export { main, processJob };
