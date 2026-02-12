import Redlock, { Lock } from 'redlock';
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

// Leader选举服务类
export class LeaderElectionService {
  private redlock: Redlock;
  private redis: Redis;
  private currentLock: Lock | null = null;
  private isLeader = false;
  private lockKey: string;
  private lockTTL: number;
  private podName: string;
  private renewalInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.lockKey = config.leaderElection.lockKey;
    this.lockTTL = config.leaderElection.lockTTL;
    this.podName = config.leaderElection.podName;

    // 创建 Redis 连接
    this.redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
    });

    // 创建 Redlock 实例
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    this.setupEventHandlers();
  }

  // 设置事件处理器
  private setupEventHandlers(): void {
    this.redlock.on('error', (error) => {
      logger.error(`Redlock error: ${error.message}`);
    });
  }

  // 尝试获取leader锁
  async acquireLeadership(): Promise<boolean> {
    try {
      // 尝试获取锁
      this.currentLock = await this.redlock.acquire([this.lockKey], this.lockTTL);
      this.isLeader = true;

      logger.info(`Pod ${this.podName} became leader`);

      // 开始自动续期
      this.startRenewal();

      return true;
    } catch (error) {
      logger.debug(`Failed to acquire leadership: ${(error as Error).message}`);
      this.isLeader = false;
      return false;
    }
  }

  // 释放leader锁
  async releaseLeadership(): Promise<void> {
    if (this.currentLock) {
      try {
        await this.currentLock.release();
        logger.info(`Pod ${this.podName} released leadership`);
      } catch (error) {
        logger.error(`Failed to release leadership: ${(error as Error).message}`);
      } finally {
        this.currentLock = null;
        this.isLeader = false;
        this.stopRenewal();
      }
    }
  }

  // 开始自动续期
  private startRenewal(): void {
    if (this.renewalInterval) {
      return;
    }

    // 每隔 lockTTL/2 时间续期一次
    const renewalPeriod = this.lockTTL / 2;

    this.renewalInterval = setInterval(async () => {
      if (this.currentLock) {
        try {
          await this.currentLock.extend(this.lockTTL);
          logger.debug(`Pod ${this.podName} renewed leadership`);
        } catch (error) {
          logger.error(`Failed to renew leadership: ${(error as Error).message}`);
          this.isLeader = false;
          this.currentLock = null;
          this.stopRenewal();
        }
      }
    }, renewalPeriod);
  }

  // 停止自动续期
  private stopRenewal(): void {
    if (this.renewalInterval) {
      clearInterval(this.renewalInterval);
      this.renewalInterval = null;
    }
  }

  // 检查是否是leader
  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  // 获取当前leader的podName
  async getCurrentLeader(): Promise<string | null> {
    try {
      const value = await this.redis.get(this.lockKey);
      return value;
    } catch (error) {
      logger.error(`Failed to get current leader: ${(error as Error).message}`);
      return null;
    }
  }

  // 等待成为leader
  async waitForLeadership(
    maxAttempts: number = 10,
    intervalMs: number = 1000
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const acquired = await this.acquireLeadership();
      if (acquired) {
        return true;
      }

      logger.debug(`Waiting for leadership, attempt ${i + 1}/${maxAttempts}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    logger.warn(`Failed to acquire leadership after ${maxAttempts} attempts`);
    return false;
  }

  // 关闭服务
  async close(): Promise<void> {
    this.stopRenewal();
    await this.releaseLeadership();
    await this.redis.quit();
    logger.info('Leader election service closed');
  }
}

// 导出单例实例
let leaderElectionServiceInstance: LeaderElectionService | null = null;

export function getLeaderElectionService(): LeaderElectionService {
  if (!leaderElectionServiceInstance) {
    leaderElectionServiceInstance = new LeaderElectionService();
  }
  return leaderElectionServiceInstance;
}
