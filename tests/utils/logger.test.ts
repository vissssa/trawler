describe('Logger', () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    jest.resetModules();
  });

  it('应该创建默认级别的日志器', () => {
    jest.isolateModules(() => {
      delete process.env.LOG_LEVEL;
      const { createLogger } = require('../../src/utils/logger');
      const logger = createLogger('test');
      expect(logger).toBeDefined();
      expect(logger.level).toBe('info');
    });
  });

  it('应该创建自定义级别的日志器', () => {
    jest.isolateModules(() => {
      process.env.LOG_LEVEL = 'debug';
      const { createLogger } = require('../../src/utils/logger');
      const logger = createLogger('test');
      expect(logger.level).toBe('debug');
    });
  });

  it('应该处理无效的日志级别', () => {
    jest.isolateModules(() => {
      process.env.LOG_LEVEL = 'invalid';
      const { createLogger } = require('../../src/utils/logger');
      const logger = createLogger('test');
      expect(logger.level).toBe('info');
    });
  });
});
