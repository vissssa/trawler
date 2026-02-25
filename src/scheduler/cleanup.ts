import { rm } from 'fs/promises';
import path from 'path';
import { Task, TaskStatus } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('scheduler:cleanup');

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
 */
export async function cleanupExpiredTasks(): Promise<number> {
  const cutoff = new Date(Date.now() - config.task.retentionDays * 24 * 60 * 60 * 1000);

  // Find expired tasks to delete their files
  const expiredTasks = await Task.find(
    {
      status: { $in: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMEOUT] },
      completedAt: { $lt: cutoff },
    },
    'taskId'
  );

  if (expiredTasks.length === 0) {
    return 0;
  }

  // Delete data files for each task
  for (const task of expiredTasks) {
    const taskDir = path.join(config.storage.dataDir, task.taskId);
    try {
      await rm(taskDir, { recursive: true, force: true });
      logger.debug({ taskId: task.taskId }, 'Deleted task data directory');
    } catch (error) {
      logger.warn({ taskId: task.taskId, error: (error as Error).message }, 'Failed to delete task data');
    }
  }

  // Delete task records from MongoDB
  const taskIds = expiredTasks.map((t) => t.taskId);
  const result = await Task.deleteMany({ taskId: { $in: taskIds } });

  logger.info({ count: result.deletedCount }, 'Cleaned up expired tasks');
  return result.deletedCount;
}

/**
 * Run all cleanup strategies.
 */
export async function runAllCleanups(): Promise<void> {
  logger.info('Running all cleanup strategies...');

  const [timedOut, orphaned, expired] = await Promise.all([
    cleanupTimedOutTasks(),
    cleanupOrphanedTasks(),
    cleanupExpiredTasks(),
  ]);

  logger.info({ timedOut, orphaned, expired }, 'Cleanup complete');
}
