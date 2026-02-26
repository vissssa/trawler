import { rm } from 'fs/promises';
import path from 'path';
import { Task, TaskStatus } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('scheduler:cleanup');

const BATCH_SIZE = 100;

/**
 * Mark tasks that have been RUNNING longer than maxTimeoutMs as TIMEOUT.
 */
export async function cleanupTimedOutTasks(): Promise<number> {
  const cutoff = new Date(Date.now() - config.task.maxTimeoutMs);

  const result = await Task.updateMany(
    {
      status: TaskStatus.RUNNING,
      startedAt: { $lt: cutoff },
    },
    {
      $set: {
        status: TaskStatus.TIMEOUT,
        completedAt: new Date(),
        errorMessage: 'Task timed out',
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info({ count: result.modifiedCount }, 'Cleaned up timed-out tasks');
  }

  return result.modifiedCount;
}

/**
 * Mark RUNNING tasks with stale updatedAt as TIMEOUT (worker crash scenario).
 * Uses 2x maxTimeoutMs as the staleness threshold.
 */
export async function cleanupOrphanedTasks(): Promise<number> {
  const staleCutoff = new Date(Date.now() - config.task.maxTimeoutMs * 2);

  const result = await Task.updateMany(
    {
      status: TaskStatus.RUNNING,
      updatedAt: { $lt: staleCutoff },
    },
    {
      $set: {
        status: TaskStatus.TIMEOUT,
        completedAt: new Date(),
        errorMessage: 'Task orphaned (worker likely crashed)',
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info({ count: result.modifiedCount }, 'Cleaned up orphaned tasks');
  }

  return result.modifiedCount;
}

/**
 * Delete completed/failed/timeout tasks older than retentionDays,
 * along with their data files on disk.
 * Processes in batches to avoid loading all expired tasks at once.
 */
export async function cleanupExpiredTasks(): Promise<number> {
  const cutoff = new Date(Date.now() - config.task.retentionDays * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  // Process in batches
  while (true) {
    const expiredTasks = await Task.find(
      {
        status: { $in: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT] },
        completedAt: { $lt: cutoff },
      },
      'taskId'
    ).limit(BATCH_SIZE);

    if (expiredTasks.length === 0) {
      break;
    }

    // Delete DB records first (authoritative source)
    const taskIds = expiredTasks.map((t) => t.taskId);
    const result = await Task.deleteMany({ taskId: { $in: taskIds } });
    totalDeleted += result.deletedCount;

    // Then delete data files (best-effort)
    for (const task of expiredTasks) {
      const taskDir = path.join(config.storage.dataDir, task.taskId);
      try {
        await rm(taskDir, { recursive: true, force: true });
        logger.debug({ taskId: task.taskId }, 'Deleted task data directory');
      } catch (error) {
        logger.warn({ taskId: task.taskId, error: (error as Error).message }, 'Failed to delete task data');
      }
    }

    // If we got fewer than BATCH_SIZE, we're done
    if (expiredTasks.length < BATCH_SIZE) {
      break;
    }
  }

  if (totalDeleted > 0) {
    logger.info({ count: totalDeleted }, 'Cleaned up expired tasks');
  }
  return totalDeleted;
}

/**
 * Run all cleanup strategies.
 */
export async function runAllCleanups(): Promise<void> {
  logger.info('Running all cleanup strategies...');

  // Run sequentially to avoid timeout/orphan query overlap on the same RUNNING tasks
  const timedOut = await cleanupTimedOutTasks();
  const orphaned = await cleanupOrphanedTasks();
  const expired = await cleanupExpiredTasks();

  logger.info({ timedOut, orphaned, expired }, 'Cleanup complete');
}
