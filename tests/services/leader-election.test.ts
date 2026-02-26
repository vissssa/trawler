import { LeaderElectionService } from '../../src/services/leader-election';
import Redlock from 'redlock';
import Redis from 'ioredis';

// Mock dependencies
jest.mock('redlock');
jest.mock('ioredis', () => {
  const mockRedisInstance = {
    on: jest.fn().mockReturnThis(),
    get: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  return jest.fn(() => mockRedisInstance);
});
jest.mock('../../src/config', () => ({
  config: {
    redis: {
      url: 'redis://localhost:6379',
    },
    leaderElection: {
      lockKey: 'test:leader',
      lockTTL: 10000,
      podName: 'test-pod',
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

describe('LeaderElectionService', () => {
  let leaderElectionService: LeaderElectionService;
  let mockRedlock: jest.Mocked<Redlock>;
  let mockRedis: jest.Mocked<Redis>;
  let mockLock: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Setup mock lock
    mockLock = {
      release: jest.fn().mockResolvedValue(undefined),
      extend: jest.fn().mockResolvedValue(undefined),
    };

    // Setup mock redlock
    mockRedlock = {
      acquire: jest.fn(),
      on: jest.fn(),
    } as any;

    // Setup mock redis — get the instance created by the constructor mock
    mockRedis = new (Redis as any)();

    // Mock constructors
    (Redlock as jest.MockedClass<typeof Redlock>).mockImplementation(() => mockRedlock);

    leaderElectionService = new LeaderElectionService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('acquireLeadership', () => {
    it('should acquire leadership successfully', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);

      const result = await leaderElectionService.acquireLeadership();

      expect(result).toBe(true);
      expect(leaderElectionService.isCurrentLeader()).toBe(true);
      expect(mockRedlock.acquire).toHaveBeenCalledWith(['test:leader'], 10000);
    });

    it('should return false when leadership acquisition fails', async () => {
      mockRedlock.acquire.mockRejectedValue(new Error('Lock already held'));

      const result = await leaderElectionService.acquireLeadership();

      expect(result).toBe(false);
      expect(leaderElectionService.isCurrentLeader()).toBe(false);
    });
  });

  describe('releaseLeadership', () => {
    it('should release leadership successfully', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);
      await leaderElectionService.acquireLeadership();

      await leaderElectionService.releaseLeadership();

      expect(mockLock.release).toHaveBeenCalled();
      expect(leaderElectionService.isCurrentLeader()).toBe(false);
    });

    it('should handle release when not leader', async () => {
      await expect(leaderElectionService.releaseLeadership()).resolves.not.toThrow();
    });
  });

  describe('isCurrentLeader', () => {
    it('should return true when is leader', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);
      await leaderElectionService.acquireLeadership();

      expect(leaderElectionService.isCurrentLeader()).toBe(true);
    });

    it('should return false when not leader', () => {
      expect(leaderElectionService.isCurrentLeader()).toBe(false);
    });
  });

  describe('getCurrentLeader', () => {
    it('should return pod name when is leader', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);
      await leaderElectionService.acquireLeadership();

      const leader = leaderElectionService.getCurrentLeader();

      expect(leader).toBe('test-pod');
    });

    it('should return unknown when not leader', () => {
      const leader = leaderElectionService.getCurrentLeader();

      expect(leader).toBe('unknown');
    });
  });

  describe('waitForLeadership', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      jest.useFakeTimers();
    });

    it('should acquire leadership on first attempt', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);

      const result = await leaderElectionService.waitForLeadership(3, 100);

      expect(result).toBe(true);
      expect(mockRedlock.acquire).toHaveBeenCalledTimes(1);
    });

    it('should retry and eventually acquire leadership', async () => {
      mockRedlock.acquire
        .mockRejectedValueOnce(new Error('Failed'))
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValueOnce(mockLock);

      const result = await leaderElectionService.waitForLeadership(5, 100);

      expect(result).toBe(true);
      expect(mockRedlock.acquire).toHaveBeenCalledTimes(3);
    });

    it('should return false after max attempts', async () => {
      mockRedlock.acquire.mockRejectedValue(new Error('Always fails'));

      const result = await leaderElectionService.waitForLeadership(3, 100);

      expect(result).toBe(false);
      expect(mockRedlock.acquire).toHaveBeenCalledTimes(3);
    });
  });

  describe('close', () => {
    it('should close all resources', async () => {
      mockRedlock.acquire.mockResolvedValue(mockLock);
      await leaderElectionService.acquireLeadership();

      await leaderElectionService.close();

      expect(mockLock.release).toHaveBeenCalled();
      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('should handle close when not leader', async () => {
      await expect(leaderElectionService.close()).resolves.not.toThrow();
    });
  });

  describe('event handlers', () => {
    it('should setup error handler on initialization', () => {
      expect(mockRedlock.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });
});
