import { config } from '../../src/config';

describe('Config', () => {
  it('应该从环境变量加载配置', () => {
    expect(config.redis.url).toBeDefined();
    expect(config.mongodb.url).toBeDefined();
    expect(config.api.port).toBe(3000);
  });
});
