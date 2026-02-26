import { Task, TaskStatus } from '../../src/models/Task';
import {
  cleanupTimedOutTasks,
  cleanupOrphanedTasks,
  cleanupExpiredTasks,
  runAllCleanups,
} from '../../src/scheduler/cleanup';

jest.mock('../../src/models/Task');
jest.mock('fs/promises');
jest.mock('../../src/config', () => ({
  config: {
    task: {
      maxTimeoutMs: 7200000,
      retentionDays: 7,
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

import { rm } from 'fs/promises';

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
  });
});
