import { rm } from 'fs/promises';
import path from 'path';
import { Task, TaskStatus } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { QueueService } from '../services/queue';
import { stalePendingReconciled, runningOrphanedByRedis } from '../services/metrics';

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
 * Cleanup stale PENDING tasks that have no corresponding BullMQ job in Redis.
 * Depending on stalePendingAction config, either re-enqueue or mark as FAILED.
 */
export async function cleanupStalePendingTasks(
  queueService: QueueService
): Promise<{ reenqueued: number; failed: number }> {
  const cutoff = new Date(Date.now() - config.task.pendingStaleMs);
  const result = { reenqueued: 0, failed: 0 };

  const staleTasks = await Task.find(
    {
      status: TaskStatus.PENDING,
      createdAt: { $lt: cutoff },
    },
    'taskId urls options'
  ).limit(BATCH_SIZE);

  if (staleTasks.length === 0) {
    return result;
  }

  for (const task of staleTasks) {
    const job = await queueService.getJob(task.taskId);
    if (job) {
      continue; // Job exists in Redis, skip
    }

    if (config.task.stalePendingAction === 'reenqueue') {
      try {
        await queueService.addJob(task.taskId, task.urls, task.options);
        result.reenqueued++;
        stalePendingReconciled.inc({ action: 'reenqueued' });
        logger.info({ taskId: task.taskId }, 'Re-enqueued stale pending task');
      } catch (error) {
        // Fallback to marking as FAILED if re-enqueue fails
        const updated = await Task.updateOne(
          { taskId: task.taskId, status: TaskStatus.PENDING },
          {
            $set: {
              status: TaskStatus.FAILED,
              completedAt: new Date(),
              errorMessage: `Stale pending task: re-enqueue failed (${(error as Error).message})`,
            },
          }
        );
        if (updated.modifiedCount > 0) {
          result.failed++;
          stalePendingReconciled.inc({ action: 'failed' });
          logger.warn({ taskId: task.taskId, error: (error as Error).message }, 'Re-enqueue failed, marked as FAILED');
        }
      }
    } else {
      const updated = await Task.updateOne(
        { taskId: task.taskId, status: TaskStatus.PENDING },
        {
          $set: {
            status: TaskStatus.FAILED,
            completedAt: new Date(),
            errorMessage: 'Stale pending task: no BullMQ job found in Redis',
          },
        }
      );
      if (updated.modifiedCount > 0) {
        result.failed++;
        stalePendingReconciled.inc({ action: 'failed' });
        logger.info({ taskId: task.taskId }, 'Marked stale pending task as FAILED');
      }
    }
  }

  if (result.reenqueued > 0 || result.failed > 0) {
    logger.info(result, 'Stale pending tasks cleanup complete');
  }

  return result;
}

/**
 * Cleanup RUNNING tasks that have no corresponding BullMQ job in Redis.
 * These are likely orphaned after a Redis restart/data loss.
 */
export async function cleanupRunningTasksWithoutJob(
  queueService: QueueService
): Promise<number> {
  const cutoff = new Date(Date.now() - config.task.runningOrphanCheckMs);

  const runningTasks = await Task.find(
    {
      status: TaskStatus.RUNNING,
      startedAt: { $lt: cutoff },
    },
    'taskId'
  ).limit(BATCH_SIZE);

  if (runningTasks.length === 0) {
    return 0;
  }

  const orphanedTaskIds: string[] = [];

  for (const task of runningTasks) {
    const job = await queueService.getJob(task.taskId);
    if (!job) {
      orphanedTaskIds.push(task.taskId);
    }
  }

  if (orphanedTaskIds.length === 0) {
    return 0;
  }

  const result = await Task.updateMany(
    {
      taskId: { $in: orphanedTaskIds },
      status: TaskStatus.RUNNING,
    },
    {
      $set: {
        status: TaskStatus.FAILED,
        completedAt: new Date(),
        errorMessage: 'Running task orphaned: no BullMQ job found in Redis',
      },
    }
  );

  if (result.modifiedCount > 0) {
    runningOrphanedByRedis.inc(result.modifiedCount);
    logger.info({ count: result.modifiedCount }, 'Cleaned up running tasks without BullMQ job');
  }

  return result.modifiedCount;
}

/**
 * Run all cleanup strategies.
 * When queueService is provided, Redis-aware strategies run first.
 */
export async function runAllCleanups(queueService?: QueueService | null): Promise<void> {
  logger.info('Running all cleanup strategies...');

  // Redis-aware strategies (run first if queueService is available)
  let stalePending = { reenqueued: 0, failed: 0 };
  let runningOrphaned = 0;
  if (queueService) {
    stalePending = await cleanupStalePendingTasks(queueService);
    runningOrphaned = await cleanupRunningTasksWithoutJob(queueService);
  }

  // Time-based strategies (always run)
  const timedOut = await cleanupTimedOutTasks();
  const orphaned = await cleanupOrphanedTasks();
  const expired = await cleanupExpiredTasks();

  logger.info({ stalePending, runningOrphaned, timedOut, orphaned, expired }, 'Cleanup complete');
}
