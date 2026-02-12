import mongoose from 'mongoose';
import { Task, TaskStatus } from '../../src/models/Task';

describe('Task Model', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/trawler-test');
  }, 10000);

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }, 10000);

  afterEach(async () => {
    await Task.deleteMany({});
  });

  it('应该创建带有必需字段的任务', async () => {
    const task = await Task.create({
      taskId: 'task_123',
      urls: ['https://example.com'],
      status: TaskStatus.PENDING,
      options: {},
      progress: { completed: 0, total: 0, failed: 0 },
      result: { files: [], stats: { success: 0, failed: 0, skipped: 0 } },
    });

    expect(task.taskId).toBe('task_123');
    expect(task.status).toBe(TaskStatus.PENDING);
    expect(task.createdAt).toBeDefined();
  });

  it('如果未提供应该生成唯一的 taskId', async () => {
    const task = await Task.create({
      urls: ['https://example.com'],
      options: {},
    });

    expect(task.taskId).toMatch(/^task_\d+_[a-f0-9]+$/);
  });
});
