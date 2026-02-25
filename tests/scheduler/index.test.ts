jest.mock('../../src/services/database', () => ({
  connectDatabase: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/leader-election');
jest.mock('../../src/scheduler/cleanup');
jest.mock('../../src/utils/logger', () => {
  const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger), logger: mockLogger };
});

import { runAllCleanups } from '../../src/scheduler/cleanup';
import { runOneCycle } from '../../src/scheduler/index';

describe('scheduler runOneCycle', () => {
  let mockLeaderService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLeaderService = {
      acquireLeadership: jest.fn().mockResolvedValue(undefined),
      isCurrentLeader: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (runAllCleanups as jest.Mock).mockResolvedValue(undefined);
  });

  it('leader 时应运行清理', async () => {
    mockLeaderService.isCurrentLeader.mockReturnValue(true);
    await runOneCycle(mockLeaderService);
    expect(runAllCleanups).toHaveBeenCalled();
    expect(mockLeaderService.acquireLeadership).not.toHaveBeenCalled();
  });

  it('非 leader 时应尝试获取领导权', async () => {
    mockLeaderService.isCurrentLeader.mockReturnValue(false);
    await runOneCycle(mockLeaderService);
    expect(mockLeaderService.acquireLeadership).toHaveBeenCalled();
    expect(runAllCleanups).not.toHaveBeenCalled();
  });

  it('获取领导权后应运行清理', async () => {
    mockLeaderService.isCurrentLeader
      .mockReturnValueOnce(false)   // first check: not leader
      .mockReturnValueOnce(true);   // after acquire: is leader
    await runOneCycle(mockLeaderService);
    expect(mockLeaderService.acquireLeadership).toHaveBeenCalled();
    expect(runAllCleanups).toHaveBeenCalled();
  });
});
