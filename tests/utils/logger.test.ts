import { createLogger } from '../../src/utils/logger';

describe('Logger', () => {
  it('应该创建默认级别的日志器', () => {
    const logger = createLogger('test');
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('应该创建自定义级别的日志器', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('test');
    expect(logger.level).toBe('debug');
  });

  it('应该处理无效的日志级别', () => {
    process.env.LOG_LEVEL = 'invalid';
    const logger = createLogger('test');
    expect(logger.level).toBe('info');
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });
});
