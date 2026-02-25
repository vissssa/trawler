import { connectDatabase } from '../services/database';
import { getLeaderElectionService } from '../services/leader-election';
import { runAllCleanups } from './cleanup';
import { createLogger } from '../utils/logger';

const logger = createLogger('scheduler');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function main(): Promise<void> {
  logger.info('Starting scheduler...');

  // Connect to MongoDB
  await connectDatabase();

  // Get leader election service
  const leaderService = getLeaderElectionService();

  // Try to acquire leadership
  await leaderService.acquireLeadership();

  let running = true;

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down scheduler...');
    running = false;
    await leaderService.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Scheduler started, entering cleanup loop...');

  // Main loop
  while (running) {
    try {
      // If not leader, try to acquire
      if (!leaderService.isCurrentLeader()) {
        await leaderService.acquireLeadership();
      }

      // Only run cleanups if we are the leader
      if (leaderService.isCurrentLeader()) {
        await runAllCleanups();
      } else {
        logger.debug('Not leader, skipping cleanup cycle');
      }
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Error in cleanup cycle');
    }

    // Wait for next cycle
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_INTERVAL_MS));
  }
}

// Run directly
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error: error.message }, 'Scheduler startup failed');
    process.exit(1);
  });
}

export { main };
