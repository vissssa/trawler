process.env.LOG_FILE = process.env.LOG_FILE || 'scheduler.log';

import { connectDatabase, disconnectDatabase } from '../services/database';
import { config } from '../config';
import { getLeaderElectionService } from '../services/leader-election';
import { QueueService, getQueueService } from '../services/queue';
import { runAllCleanups } from './cleanup';
import { createLogger } from '../utils/logger';

const logger = createLogger('scheduler');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runOneCycle(
  leaderService: ReturnType<typeof getLeaderElectionService> | null,
  queueService: QueueService | null
): Promise<void> {
  // If leader election is disabled, always run cleanup
  if (!leaderService) {
    await runAllCleanups(queueService);
    return;
  }

  if (!leaderService.isCurrentLeader()) {
    await leaderService.acquireLeadership();
  }

  if (leaderService.isCurrentLeader()) {
    await runAllCleanups(queueService);
  } else {
    logger.debug('Not leader, skipping cleanup cycle');
  }
}

/** Sleep that can be interrupted by calling the returned abort function */
function interruptibleSleep(ms: number): { promise: Promise<void>; abort: () => void } {
  let timer: NodeJS.Timeout;
  let abortFn: () => void;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    abortFn = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, abort: abortFn! };
}

async function main(): Promise<void> {
  logger.info('Starting scheduler...');

  // Connect to MongoDB
  await connectDatabase();

  // Initialize QueueService for Redis-aware cleanup
  let queueService: QueueService | null = null;
  try {
    queueService = getQueueService();
    const isHealthy = await queueService.ping();
    if (isHealthy) {
      logger.info('QueueService initialized, Redis-aware cleanup enabled');
    } else {
      logger.warn('Redis ping failed, Redis-aware cleanup disabled');
      queueService = null;
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to initialize QueueService, Redis-aware cleanup disabled');
    queueService = null;
  }

  // Get leader election service (only if enabled)
  let leaderService: ReturnType<typeof getLeaderElectionService> | null = null;
  if (config.leaderElection.enabled) {
    leaderService = getLeaderElectionService();
    await leaderService.acquireLeadership();
    logger.info('Leader election enabled');
  } else {
    logger.info('Leader election disabled, running as standalone scheduler');
  }

  let running = true;
  let currentSleep: { abort: () => void } | null = null;

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down scheduler...');
    running = false;
    // Wake up the sleep timer immediately
    if (currentSleep) {
      currentSleep.abort();
    }
    try {
      if (leaderService) {
        await leaderService.close();
      }
      if (queueService) {
        await queueService.close();
      }
      await disconnectDatabase();
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Error during shutdown');
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run initial consistency check immediately on startup
  logger.info('Running initial consistency check...');
  try {
    await runOneCycle(leaderService, queueService);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error in initial consistency check');
  }

  logger.info('Scheduler started, entering cleanup loop...');

  // Main loop
  while (running) {
    // Wait for next cycle (interruptible)
    const sleep = interruptibleSleep(CLEANUP_INTERVAL_MS);
    currentSleep = sleep;
    await sleep.promise;
    currentSleep = null;

    if (!running) break;

    try {
      await runOneCycle(leaderService, queueService);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Error in cleanup cycle');
    }
  }

  logger.info('Scheduler loop exited');
  process.exit(0);
}

// Run directly
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error: error.message }, 'Scheduler startup failed');
    process.exit(1);
  });
}

export { main, runOneCycle };
