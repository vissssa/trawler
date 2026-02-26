import { Task, TaskStatus } from '../../src/models/Task';
import {
  cleanupTimedOutTasks,
  cleanupOrphanedTasks,
  cleanupExpiredTasks,
  cleanupStalePendingTasks,
  cleanupRunningTasksWithoutJob,
  runAllCleanups,
} from '../../src/scheduler/cleanup';

jest.mock('../../src/models/Task');
jest.mock('fs/promises');
jest.mock('../../src/config', () => ({
  config: {
    task: {
      maxTimeoutMs: 7200000,
      retentionDays: 7,
      pendingStaleMs: 1800000,
      runningOrphanCheckMs: 600000,
      stalePendingAction: 'reenqueue',
    },
    storage: {
      dataDir: '/tmp/test-data',
    },
  },
}));
jest.mock('../../src/utils/logger', () => {
  const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger), logger: mockLogger };
});
jest.mock('../../src/services/metrics', () => ({
  stalePendingReconciled: { inc: jest.fn() },
  runningOrphanedByRedis: { inc: jest.fn() },
}));

import { rm } from 'fs/promises';
import { config } from '../../src/config';
import { stalePendingReconciled, runningOrphanedByRedis } from '../../src/services/metrics';

// Helper to create a mock QueueService
function createMockQueueService() {
  return {
    getJob: jest.fn(),
    addJob: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('scheduler cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cleanupTimedOutTasks', () => {
    it('应该将超时的 RUNNING 任务标记为 TIMEOUT', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });

      const count = await cleanupTimedOutTasks();

      expect(count).toBe(2);
      expect(Task.updateMany).toHaveBeenCalledWith(
        {
          status: TaskStatus.RUNNING,
          startedAt: { $lt: expect.any(Date) },
        },
        {
          $set: {
            status: TaskStatus.TIMEOUT,
            completedAt: expect.any(Date),
            errorMessage: 'Task timed out',
          },
        }
      );
    });

    it('无超时任务时应返回 0', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });

      const count = await cleanupTimedOutTasks();
      expect(count).toBe(0);
    });
  });

  describe('cleanupOrphanedTasks', () => {
    it('应该将孤儿 RUNNING 任务标记为 TIMEOUT', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 1 });

      const count = await cleanupOrphanedTasks();

      expect(count).toBe(1);
      expect(Task.updateMany).toHaveBeenCalledWith(
        {
          status: TaskStatus.RUNNING,
          updatedAt: { $lt: expect.any(Date) },
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: TaskStatus.TIMEOUT,
            errorMessage: 'Task orphaned (worker likely crashed)',
          }),
        })
      );
    });
  });

  describe('cleanupExpiredTasks', () => {
    it('应该删除过期任务及其文件', async () => {
      const expiredTasks = [
        { taskId: 'task_old1' },
        { taskId: 'task_old2' },
      ];
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue(expiredTasks),
      });
      (Task.deleteMany as jest.Mock).mockResolvedValue({ deletedCount: 2 });
      (rm as jest.Mock).mockResolvedValue(undefined);

      const count = await cleanupExpiredTasks();

      expect(count).toBe(2);
      // DB records deleted first, then files
      expect(Task.deleteMany).toHaveBeenCalledWith({
        taskId: { $in: ['task_old1', 'task_old2'] },
      });
      expect(rm).toHaveBeenCalledTimes(2);
      expect(rm).toHaveBeenCalledWith(
        expect.stringContaining('task_old1'),
        { recursive: true, force: true }
      );
    });

    it('无过期任务时应返回 0', async () => {
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      const count = await cleanupExpiredTasks();
      expect(count).toBe(0);
    });

    it('文件删除失败时应继续删除 MongoDB 记录', async () => {
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([{ taskId: 'task_broken' }]),
      });
      (Task.deleteMany as jest.Mock).mockResolvedValue({ deletedCount: 1 });
      (rm as jest.Mock).mockRejectedValue(new Error('ENOENT'));

      const count = await cleanupExpiredTasks();

      expect(count).toBe(1);
      expect(Task.deleteMany).toHaveBeenCalled();
    });
  });

  describe('cleanupStalePendingTasks', () => {
    it('pending 任务有 BullMQ job 时应跳过不处理', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1', urls: ['http://a.com'], options: {} },
        ]),
      });
      mockQS.getJob.mockResolvedValue({ id: 'task_1' }); // job exists

      const result = await cleanupStalePendingTasks(mockQS as any);

      expect(result).toEqual({ reenqueued: 0, failed: 0 });
      expect(mockQS.addJob).not.toHaveBeenCalled();
      expect(Task.updateOne).not.toHaveBeenCalled();
    });

    it('pending 任务无 BullMQ job + action=reenqueue 时应重新入队', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1', urls: ['http://a.com'], options: {} },
        ]),
      });
      mockQS.getJob.mockResolvedValue(undefined); // no job
      mockQS.addJob.mockResolvedValue({});

      const result = await cleanupStalePendingTasks(mockQS as any);

      expect(result).toEqual({ reenqueued: 1, failed: 0 });
      expect(mockQS.addJob).toHaveBeenCalledWith('task_1', ['http://a.com'], {});
      expect(stalePendingReconciled.inc).toHaveBeenCalledWith({ action: 'reenqueued' });
    });

    it('pending 任务无 BullMQ job + action=fail 时应标记 FAILED', async () => {
      const mockQS = createMockQueueService();
      // Override config for this test
      const cfg = config as any;
      const originalAction = cfg.task.stalePendingAction;
      cfg.task = { ...cfg.task, stalePendingAction: 'fail' };

      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1', urls: ['http://a.com'], options: {} },
        ]),
      });
      mockQS.getJob.mockResolvedValue(undefined);
      (Task.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });

      const result = await cleanupStalePendingTasks(mockQS as any);

      expect(result).toEqual({ reenqueued: 0, failed: 1 });
      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_1', status: TaskStatus.PENDING },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: TaskStatus.FAILED,
            errorMessage: 'Stale pending task: no BullMQ job found in Redis',
          }),
        })
      );
      expect(stalePendingReconciled.inc).toHaveBeenCalledWith({ action: 'failed' });

      // Restore config
      cfg.task = { ...cfg.task, stalePendingAction: originalAction };
    });

    it('addJob 失败时应降级标记 FAILED', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1', urls: ['http://a.com'], options: {} },
        ]),
      });
      mockQS.getJob.mockResolvedValue(undefined);
      mockQS.addJob.mockRejectedValue(new Error('Redis connection lost'));
      (Task.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });

      const result = await cleanupStalePendingTasks(mockQS as any);

      expect(result).toEqual({ reenqueued: 0, failed: 1 });
      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_1', status: TaskStatus.PENDING },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: TaskStatus.FAILED,
            errorMessage: expect.stringContaining('re-enqueue failed'),
          }),
        })
      );
      expect(stalePendingReconciled.inc).toHaveBeenCalledWith({ action: 'failed' });
    });

    it('pending 任务未超过阈值时不应处理', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await cleanupStalePendingTasks(mockQS as any);

      expect(result).toEqual({ reenqueued: 0, failed: 0 });
      expect(mockQS.getJob).not.toHaveBeenCalled();
    });

    it('空结果集应返回 {reenqueued: 0, failed: 0}', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await cleanupStalePendingTasks(mockQS as any);
      expect(result).toEqual({ reenqueued: 0, failed: 0 });
    });
  });

  describe('cleanupRunningTasksWithoutJob', () => {
    it('running 任务无 BullMQ job 时应标记 FAILED', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1' },
          { taskId: 'task_2' },
        ]),
      });
      mockQS.getJob.mockResolvedValue(undefined); // no jobs in Redis
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });

      const count = await cleanupRunningTasksWithoutJob(mockQS as any);

      expect(count).toBe(2);
      expect(Task.updateMany).toHaveBeenCalledWith(
        {
          taskId: { $in: ['task_1', 'task_2'] },
          status: TaskStatus.RUNNING,
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: TaskStatus.FAILED,
            errorMessage: 'Running task orphaned: no BullMQ job found in Redis',
          }),
        })
      );
      expect(runningOrphanedByRedis.inc).toHaveBeenCalledWith(2);
    });

    it('running 任务有 BullMQ job 时应跳过', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([
          { taskId: 'task_1' },
        ]),
      });
      mockQS.getJob.mockResolvedValue({ id: 'task_1' }); // job exists

      const count = await cleanupRunningTasksWithoutJob(mockQS as any);

      expect(count).toBe(0);
      // updateMany should not be called because no orphaned tasks
    });

    it('running 任务未超过阈值时不应处理', async () => {
      const mockQS = createMockQueueService();
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      const count = await cleanupRunningTasksWithoutJob(mockQS as any);

      expect(count).toBe(0);
      expect(mockQS.getJob).not.toHaveBeenCalled();
    });
  });

  describe('runAllCleanups', () => {
    it('应该依次执行所有清理策略', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      await runAllCleanups();

      // updateMany called 2 times (timedOut + orphaned)
      expect(Task.updateMany).toHaveBeenCalledTimes(2);
      // find called 1 time (expired)
      expect(Task.find).toHaveBeenCalledTimes(1);
    });

    it('queueService 存在时应执行 5 个策略', async () => {
      const mockQS = createMockQueueService();
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      await runAllCleanups(mockQS as any);

      // find called 3 times: stalePending + runningWithoutJob + expired
      expect(Task.find).toHaveBeenCalledTimes(3);
      // updateMany called 2 times: timedOut + orphaned (no running orphans found by Redis check)
      expect(Task.updateMany).toHaveBeenCalledTimes(2);
    });

    it('queueService 为 null 时应只执行 3 个原有策略', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      await runAllCleanups(null);

      // updateMany called 2 times (timedOut + orphaned)
      expect(Task.updateMany).toHaveBeenCalledTimes(2);
      // find called 1 time (expired only, no Redis-aware cleanups)
      expect(Task.find).toHaveBeenCalledTimes(1);
    });

    it('无参调用应向后兼容', async () => {
      (Task.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
      (Task.find as jest.Mock).mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      });

      await runAllCleanups();

      expect(Task.updateMany).toHaveBeenCalledTimes(2);
      expect(Task.find).toHaveBeenCalledTimes(1);
    });
  });
});
