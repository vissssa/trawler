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

      const mockJob = {
        data: {
          taskId: 'task_ok',
          urls: ['https://example.com'],
          options: { maxDepth: 2 },
        },
      } as Job<any>;

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

    it('失败时应将任务标记为 FAILED 并重新抛出错误', async () => {
      const crawlError = new Error('Browser crashed');
      const mockCrawler = { run: jest.fn().mockRejectedValue(crawlError) };
      (createCrawler as jest.Mock).mockReturnValue(mockCrawler);

      const mockJob = {
        data: {
          taskId: 'task_err',
          urls: ['https://example.com'],
          options: {},
        },
      } as Job<any>;

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
  });
});
