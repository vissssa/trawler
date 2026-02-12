import { config } from '../../src/config';

describe('Config', () => {
  it('应该从环境变量加载配置', () => {
    expect(config.redis.url).toBeDefined();
    expect(config.mongodb.url).toBeDefined();
    expect(config.api.port).toBe(3000);
  });

  it('应该使用默认值当端口号无效时', () => {
    process.env.API_PORT = 'invalid';
    // 重新加载模块
    jest.resetModules();
    const { config } = require('../../src/config');
    expect(config.api.port).toBe(3000);
  });

  it('应该使用默认值当端口号超出范围时', () => {
    process.env.API_PORT = '99999';
    jest.resetModules();
    const { config } = require('../../src/config');
    expect(config.api.port).toBe(3000);
  });
});
