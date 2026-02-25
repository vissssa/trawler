import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/api/server';
import { Task, TaskStatus } from '../../src/models/Task';
import { getQueueService } from '../../src/services/queue';

// Mock dependencies
jest.mock('../../src/models/Task');
jest.mock('../../src/services/queue');
jest.mock('../../src/config', () => ({
  config: {
    env: 'test',
    api: {
      port: 3001,
    },
  },
}));
jest.mock('../../src/utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  };
  return {
    createLogger: jest.fn(() => mockLogger),
    logger: mockLogger,
  };
});

describe('Task Management API', () => {
  let server: FastifyInstance;
  let mockQueueService: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mock queue service
    mockQueueService = {
      addJob: jest.fn(),
      removeJob: jest.fn(),
      getStats: jest.fn(),
    };
    (getQueueService as jest.Mock).mockReturnValue(mockQueueService);

    server = await createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('POST /tasks', () => {
    it('should create a new task', async () => {
      const mockTask = {
        taskId: 'task_123',
        urls: ['https://example.com'],
        status: TaskStatus.PENDING,
        options: {},
        progress: { completed: 0, total: 1, failed: 0 },
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(true),
      };

      (Task as any).mockImplementation(() => mockTask);
      mockQueueService.addJob.mockResolvedValue({ id: 'task_123' });

      const response = await server.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: ['https://example.com'],
          options: {
            maxDepth: 2,
          },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.taskId).toBe('task_123');
      expect(body.status).toBe(TaskStatus.PENDING);
      expect(mockTask.save).toHaveBeenCalled();
      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        'task_123',
        ['https://example.com'],
        { maxDepth: 2 }
      );
    });

    it('should reject invalid URLs', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: ['not-a-url'],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject empty URLs array', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: [],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should deduplicate URLs', async () => {
      const mockTask = {
        taskId: 'task_dedup',
        urls: ['https://example.com', 'https://other.com'],
        status: TaskStatus.PENDING,
        options: {},
        progress: { completed: 0, total: 2, failed: 0 },
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(true),
      };

      (Task as any).mockImplementation((data: any) => {
        // Verify deduplicated urls are passed to constructor
        expect(data.urls).toEqual(['https://example.com', 'https://other.com']);
        expect(data.progress.total).toBe(2);
        return mockTask;
      });
      mockQueueService.addJob.mockResolvedValue({ id: 'task_dedup' });

      const response = await server.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: [
            'https://example.com',
            'https://other.com',
            'https://example.com',
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        'task_dedup',
        ['https://example.com', 'https://other.com'],
        {}
      );
    });
  });

  describe('GET /tasks/:taskId', () => {
    it('should get task details', async () => {
      const mockTask = {
        taskId: 'task_123',
        urls: ['https://example.com'],
        status: TaskStatus.RUNNING,
        options: { maxDepth: 2 },
        progress: { completed: 1, total: 2, failed: 0 },
        result: { files: [], stats: { success: 0, failed: 0, skipped: 0 } },
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
      };

      (Task.findOne as jest.Mock).mockResolvedValue(mockTask);

      const response = await server.inject({
        method: 'GET',
        url: '/tasks/task_123',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.taskId).toBe('task_123');
      expect(body.status).toBe(TaskStatus.RUNNING);
      expect(Task.findOne).toHaveBeenCalledWith({ taskId: 'task_123' });
    });

    it('should return 404 for non-existent task', async () => {
      (Task.findOne as jest.Mock).mockResolvedValue(null);

      const response = await server.inject({
        method: 'GET',
        url: '/tasks/nonexistent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Found');
    });
  });

  describe('GET /tasks', () => {
    it('should list all tasks', async () => {
      const mockTasks = [
        {
          taskId: 'task_1',
          urls: ['https://example.com'],
          status: TaskStatus.COMPLETED,
          progress: { completed: 1, total: 1, failed: 0 },
          createdAt: new Date(),
        },
        {
          taskId: 'task_2',
          urls: ['https://test.com'],
          status: TaskStatus.PENDING,
          progress: { completed: 0, total: 1, failed: 0 },
          createdAt: new Date(),
        },
      ];

      (Task.find as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockResolvedValue(mockTasks),
      });
      (Task.countDocuments as jest.Mock).mockResolvedValue(2);

      const response = await server.inject({
        method: 'GET',
        url: '/tasks?limit=10&offset=0',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tasks).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
    });

    it('should filter tasks by status', async () => {
      const mockTasks = [
        {
          taskId: 'task_1',
          urls: ['https://example.com'],
          status: TaskStatus.COMPLETED,
          progress: { completed: 1, total: 1, failed: 0 },
          createdAt: new Date(),
        },
      ];

      (Task.find as jest.Mock).mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockResolvedValue(mockTasks),
      });
      (Task.countDocuments as jest.Mock).mockResolvedValue(1);

      const response = await server.inject({
        method: 'GET',
        url: '/tasks?status=completed',
      });

      expect(response.statusCode).toBe(200);
      expect(Task.find).toHaveBeenCalledWith({ status: TaskStatus.COMPLETED });
    });
  });

  describe('PATCH /tasks/:taskId', () => {
    it('should update task status', async () => {
      const mockTask = {
        taskId: 'task_123',
        status: TaskStatus.PENDING,
        updatedAt: new Date(),
        save: jest.fn().mockResolvedValue(true),
      };

      (Task.findOne as jest.Mock).mockResolvedValue(mockTask);

      const response = await server.inject({
        method: 'PATCH',
        url: '/tasks/task_123',
        payload: {
          status: TaskStatus.RUNNING,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.taskId).toBe('task_123');
      expect(body.status).toBe(TaskStatus.RUNNING);
      expect(mockTask.save).toHaveBeenCalled();
    });

    it('should return 404 for non-existent task', async () => {
      (Task.findOne as jest.Mock).mockResolvedValue(null);

      const response = await server.inject({
        method: 'PATCH',
        url: '/tasks/nonexistent',
        payload: {
          status: TaskStatus.RUNNING,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /tasks/:taskId', () => {
    it('should delete a task', async () => {
      const mockTask = {
        taskId: 'task_123',
      };

      (Task.findOne as jest.Mock).mockResolvedValue(mockTask);
      (Task.deleteOne as jest.Mock).mockResolvedValue({ deletedCount: 1 });
      mockQueueService.removeJob.mockResolvedValue(undefined);

      const response = await server.inject({
        method: 'DELETE',
        url: '/tasks/task_123',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('deleted successfully');
      expect(mockQueueService.removeJob).toHaveBeenCalledWith('task_123');
      expect(Task.deleteOne).toHaveBeenCalledWith({ taskId: 'task_123' });
    });

    it('should return 404 for non-existent task', async () => {
      (Task.findOne as jest.Mock).mockResolvedValue(null);

      const response = await server.inject({
        method: 'DELETE',
        url: '/tasks/nonexistent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /tasks/:taskId/progress', () => {
    it('should get task progress', async () => {
      const mockTask = {
        taskId: 'task_123',
        status: TaskStatus.RUNNING,
        progress: {
          completed: 5,
          total: 10,
          failed: 1,
          currentUrl: 'https://example.com/page5',
        },
      };

      // Clear any previous mocks and handle field selection
      (Task.findOne as jest.Mock).mockReset();
      (Task.findOne as jest.Mock).mockImplementation((query, fields) => {
        // Always return the full mock object with all fields
        // Mongoose handles field projection, but in testing we just return everything
        return Promise.resolve(mockTask);
      });

      const response = await server.inject({
        method: 'GET',
        url: '/tasks/task_123/progress',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.taskId).toBe('task_123');
      expect(body.status).toBe(TaskStatus.RUNNING);
      expect(body.progress).toBeDefined();
      expect(body.progress.completed).toBe(5);
      expect(body.progress.total).toBe(10);
    });

    it('should return 404 for non-existent task', async () => {
      (Task.findOne as jest.Mock).mockResolvedValue(null);

      const response = await server.inject({
        method: 'GET',
        url: '/tasks/nonexistent/progress',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /queue/stats', () => {
    it('should get queue statistics', async () => {
      const mockStats = {
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
      };

      mockQueueService.getStats.mockResolvedValue(mockStats);

      const response = await server.inject({
        method: 'GET',
        url: '/queue/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual(mockStats);
      expect(mockQueueService.getStats).toHaveBeenCalled();
    });
  });
});
