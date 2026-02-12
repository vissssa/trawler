import { TaskStatus, Task } from '../../src/models/Task';

describe('Task Model Definition', () => {
  it('应该导出 TaskStatus 枚举', () => {
    expect(TaskStatus.PENDING).toBe('pending');
    expect(TaskStatus.RUNNING).toBe('running');
    expect(TaskStatus.COMPLETED).toBe('completed');
    expect(TaskStatus.FAILED).toBe('failed');
    expect(TaskStatus.TIMEOUT).toBe('timeout');
  });

  it('应该导出 Task 模型', () => {
    expect(Task).toBeDefined();
    expect(Task.modelName).toBe('Task');
  });

  it('Task schema 应该有正确的字段定义', () => {
    const schema = Task.schema;

    expect(schema.path('taskId')).toBeDefined();
    expect(schema.path('urls')).toBeDefined();
    expect(schema.path('status')).toBeDefined();
    expect(schema.path('options')).toBeDefined();
    expect(schema.path('progress.completed')).toBeDefined();
    expect(schema.path('result.files')).toBeDefined();
    expect(schema.path('startedAt')).toBeDefined();
    expect(schema.path('completedAt')).toBeDefined();
    expect(schema.path('errorMessage')).toBeDefined();
    expect(schema.path('createdAt')).toBeDefined();
    expect(schema.path('updatedAt')).toBeDefined();
  });

  it('status 字段应该有正确的枚举值', () => {
    const statusPath = Task.schema.path('status') as any;
    expect(statusPath.enumValues).toEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'timeout',
    ]);
  });

  it('taskId 字段应该是必需且唯一的', () => {
    const taskIdPath = Task.schema.path('taskId') as any;
    expect(taskIdPath.isRequired).toBe(true);
    expect(taskIdPath.options.unique).toBe(true);
  });

  it('urls 字段应该是必需的', () => {
    const urlsPath = Task.schema.path('urls') as any;
    expect(urlsPath.isRequired).toBe(true);
  });
});
