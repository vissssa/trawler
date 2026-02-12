import { connectDatabase, disconnectDatabase } from '../../src/services/database';

describe('Database Service', () => {
  it('应该导出 connectDatabase 函数', () => {
    expect(connectDatabase).toBeDefined();
    expect(typeof connectDatabase).toBe('function');
  });

  it('应该导出 disconnectDatabase 函数', () => {
    expect(disconnectDatabase).toBeDefined();
    expect(typeof disconnectDatabase).toBe('function');
  });
});
