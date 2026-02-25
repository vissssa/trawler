import { Job } from 'bullmq';
import { Task, TaskStatus } from '../../src/models/Task';
import { processJob } from '../../src/worker/consumer';
import { createCrawler } from '../../src/worker/crawler';

jest.mock('bullmq');
jest.mock('ioredis');
jest.mock('../../src/services/database', () => ({
  connectDatabase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/models/Task');
jest.mock('../../src/worker/crawler');
jest.mock('../../src/config', () => ({
  config: {
    redis: { url: 'redis://localhost:6379' },
  },
}));
jest.mock('../../src/utils/logger', () => {
  const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger), logger: mockLogger };
});

describe('consumer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Task.updateOne as jest.Mock).mockResolvedValue({});
  });

  describe('processJob', () => {
    it('成功时应将任务标记为 COMPLETED', async () => {
      const mockCrawler = { run: jest.fn().mockResolvedValue(undefined) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);
      // After crawler.run, findOne is called to check progress
      (Task.findOne as jest.Mock).mockResolvedValue({
        progress: { completed: 1, failed: 0 },
      });

      const mockJob = {
        data: {
          taskId: 'task_ok',
          urls: ['https://example.com'],
          options: { maxDepth: 2 },
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as unknown as Job<any>;

      await processJob(mockJob);

      // First call: set RUNNING
      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_ok' },
        { $set: { status: TaskStatus.RUNNING, startedAt: expect.any(Date) } }
      );
      // Second call: set COMPLETED
      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_ok' },
        { $set: { status: TaskStatus.COMPLETED, completedAt: expect.any(Date) } }
      );
      expect(mockCrawler.run).toHaveBeenCalledWith(['https://example.com']);
    });

    it('所有页面失败时应标记为 FAILED', async () => {
      const mockCrawler = { run: jest.fn().mockResolvedValue(undefined) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);
      (Task.findOne as jest.Mock).mockResolvedValue({
        progress: { completed: 0, failed: 3 },
      });

      const mockJob = {
        data: {
          taskId: 'task_all_fail',
          urls: ['https://a.com', 'https://b.com', 'https://c.com'],
          options: {},
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as unknown as Job<any>;

      await processJob(mockJob);

      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_all_fail' },
        {
          $set: {
            status: TaskStatus.FAILED,
            completedAt: expect.any(Date),
            errorMessage: 'All 3 pages failed',
          },
        }
      );
    });

    it('最后一次重试失败时应将任务标记为 FAILED', async () => {
      const crawlError = new Error('Browser crashed');
      const mockCrawler = { run: jest.fn().mockRejectedValue(crawlError) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);

      const mockJob = {
        data: {
          taskId: 'task_err',
          urls: ['https://example.com'],
          options: {},
        },
        attemptsMade: 2, // 3rd attempt (0-indexed), final with attempts:3
        opts: { attempts: 3 },
      } as unknown as Job<any>;

      await expect(processJob(mockJob)).rejects.toThrow('Browser crashed');

      expect(Task.updateOne).toHaveBeenCalledWith(
        { taskId: 'task_err' },
        {
          $set: {
            status: TaskStatus.FAILED,
            completedAt: expect.any(Date),
            errorMessage: 'Browser crashed',
          },
        }
      );
    });

    it('非最后一次重试失败时不应标记为 FAILED', async () => {
      const crawlError = new Error('Temporary error');
      const mockCrawler = { run: jest.fn().mockRejectedValue(crawlError) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);

      const mockJob = {
        data: {
          taskId: 'task_retry',
          urls: ['https://example.com'],
          options: {},
        },
        attemptsMade: 0, // 1st attempt, still has retries
        opts: { attempts: 3 },
      } as unknown as Job<any>;

      await expect(processJob(mockJob)).rejects.toThrow('Temporary error');

      // Should have set RUNNING but NOT FAILED
      const updateCalls = (Task.updateOne as jest.Mock).mock.calls;
      expect(updateCalls).toHaveLength(1); // Only the RUNNING update
      expect(updateCalls[0][1].$set.status).toBe(TaskStatus.RUNNING);
    });

    it('重试时应重置 progress 和 result', async () => {
      const mockCrawler = { run: jest.fn().mockResolvedValue(undefined) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);
      (Task.findOne as jest.Mock).mockResolvedValue({
        progress: { completed: 1, failed: 0 },
      });

      const mockJob = {
        data: {
          taskId: 'task_retry2',
          urls: ['https://example.com'],
          options: {},
        },
        attemptsMade: 1, // 2nd attempt = retry
        opts: { attempts: 3 },
      } as unknown as Job<any>;

      await processJob(mockJob);

      // First call on retry: reset progress and result
      const firstCall = (Task.updateOne as jest.Mock).mock.calls[0];
      expect(firstCall[1].$set.status).toBe(TaskStatus.RUNNING);
      expect(firstCall[1].$set.progress).toEqual({
        completed: 0,
        total: 1,
        failed: 0,
        currentUrl: '',
      });
      expect(firstCall[1].$set.result).toEqual({
        files: [],
        errors: [],
        stats: { success: 0, failed: 0 },
      });
    });
  });
});
