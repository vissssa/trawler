import { QueueService } from '../../src/services/queue';
import { Queue, QueueEvents } from 'bullmq';

// Mock dependencies
jest.mock('bullmq');
jest.mock('ioredis');
jest.mock('../../src/config', () => ({
  config: {
    redis: {
      url: 'redis://localhost:6379',
    },
    task: {
      maxTimeoutMs: 7200000,
    },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('QueueService', () => {
  let queueService: QueueService;
  let mockQueue: jest.Mocked<Queue>;
  let mockQueueEvents: jest.Mocked<QueueEvents>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock queue
    mockQueue = {
      add: jest.fn(),
      getJob: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      getWaitingCount: jest.fn(),
      getActiveCount: jest.fn(),
      getCompletedCount: jest.fn(),
      getFailedCount: jest.fn(),
      getDelayedCount: jest.fn(),
      clean: jest.fn(),
      close: jest.fn(),
    } as any;

    // Setup mock queue events
    mockQueueEvents = {
      on: jest.fn(),
      close: jest.fn(),
    } as any;

    // Mock constructors
    (Queue as jest.MockedClass<typeof Queue>).mockImplementation(() => mockQueue);
    (QueueEvents as jest.MockedClass<typeof QueueEvents>).mockImplementation(
      () => mockQueueEvents
    );

    queueService = new QueueService();
  });

  describe('addJob', () => {
    it('should add a job to the queue', async () => {
      const mockJob = { id: 'task_123' };
      mockQueue.add.mockResolvedValue(mockJob as any);

      const result = await queueService.addJob('task_123', ['https://example.com'], {
        maxDepth: 2,
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        'task_123',
        {
          taskId: 'task_123',
          urls: ['https://example.com'],
          options: { maxDepth: 2 },
        },
        {
          jobId: 'task_123',
        }
      );
      expect(result).toBe(mockJob);
    });
  });

  describe('getJob', () => {
    it('should retrieve a job by taskId', async () => {
      const mockJob = { id: 'task_123', data: {} };
      mockQueue.getJob.mockResolvedValue(mockJob as any);

      const result = await queueService.getJob('task_123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('task_123');
      expect(result).toBe(mockJob);
    });

    it('should return undefined if job not found', async () => {
      mockQueue.getJob.mockResolvedValue(undefined);

      const result = await queueService.getJob('nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('removeJob', () => {
    it('should remove a job from the queue', async () => {
      const mockJob = {
        id: 'task_123',
        remove: jest.fn(),
      };
      mockQueue.getJob.mockResolvedValue(mockJob as any);

      await queueService.removeJob('task_123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('task_123');
      expect(mockJob.remove).toHaveBeenCalled();
    });

    it('should handle removing non-existent job', async () => {
      mockQueue.getJob.mockResolvedValue(undefined);

      await expect(queueService.removeJob('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('pause and resume', () => {
    it('should pause the queue', async () => {
      mockQueue.pause.mockResolvedValue();

      await queueService.pause();

      expect(mockQueue.pause).toHaveBeenCalled();
    });

    it('should resume the queue', async () => {
      mockQueue.resume.mockResolvedValue();

      await queueService.resume();

      expect(mockQueue.resume).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return queue statistics', async () => {
      mockQueue.getWaitingCount.mockResolvedValue(5);
      mockQueue.getActiveCount.mockResolvedValue(2);
      mockQueue.getCompletedCount.mockResolvedValue(100);
      mockQueue.getFailedCount.mockResolvedValue(3);
      mockQueue.getDelayedCount.mockResolvedValue(1);

      const stats = await queueService.getStats();

      expect(stats).toEqual({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
      });
    });
  });

  describe('clean', () => {
    it('should clean completed jobs', async () => {
      mockQueue.clean.mockResolvedValue(['job1', 'job2']);

      const result = await queueService.cleanCompleted(3600);

      expect(mockQueue.clean).toHaveBeenCalledWith(3600, 1000, 'completed');
      expect(result).toEqual(['job1', 'job2']);
    });

    it('should clean failed jobs', async () => {
      mockQueue.clean.mockResolvedValue(['job3']);

      const result = await queueService.cleanFailed(7200);

      expect(mockQueue.clean).toHaveBeenCalledWith(7200, 1000, 'failed');
      expect(result).toEqual(['job3']);
    });
  });

  describe('getQueue and getQueueEvents', () => {
    it('should return queue instance', () => {
      expect(queueService.getQueue()).toBe(mockQueue);
    });

    it('should return queue events instance', () => {
      expect(queueService.getQueueEvents()).toBe(mockQueueEvents);
    });
  });

  describe('close', () => {
    it('should close all connections', async () => {
      const mockConnection = {
        quit: jest.fn().mockResolvedValue('OK'),
      };

      // Access the private connection field for testing
      (queueService as any).connection = mockConnection;

      await queueService.close();

      expect(mockQueue.close).toHaveBeenCalled();
      expect(mockQueueEvents.close).toHaveBeenCalled();
      expect(mockConnection.quit).toHaveBeenCalled();
    });
  });

  describe('event handlers', () => {
    it('should setup event handlers on initialization', () => {
      expect(mockQueueEvents.on).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(mockQueueEvents.on).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockQueueEvents.on).toHaveBeenCalledWith('progress', expect.any(Function));
    });
  });
});
