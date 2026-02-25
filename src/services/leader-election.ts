import Redlock, { Lock } from 'redlock';
import Redis from 'ioredis';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('leader-election');

// Leader选举服务类
export class LeaderElectionService {
  private redlock: Redlock;
  private redis: Redis;
  private currentLock: Lock | null = null;
  private isLeader = false;
  private lockKey: string;
  private lockTTL: number;
  private podName: string;

  constructor() {
    this.lockKey = config.leaderElection.lockKey;
    this.lockTTL = config.leaderElection.lockTTL;
    this.podName = config.leaderElection.podName;

    // 创建 Redis 连接
    this.redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
    });

    // 创建 Redlock 实例
    // automaticExtensionThreshold: 当锁剩余时间小于此值时自动续期
    // 设为 lockTTL / 2，确保在锁过期前充分续期
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: this.lockTTL / 2,
    });

    this.setupEventHandlers();
  }

  // 设置事件处理器
  private setupEventHandlers(): void {
    this.redlock.on('error', (error) => {
      // 忽略获取锁失败的重试错误（正常竞争行为）
      if (error.message.includes('The operation was unable to achieve a quorum')) {
        logger.debug(`Redlock contention: ${error.message}`);
      } else {
        logger.warn(`Redlock error: ${error.message}`);
        // Lock extension failure — reset leader status to prevent split-brain
        if (this.isLeader) {
          logger.warn('Resetting leader status due to Redlock error');
          this.isLeader = false;
          this.currentLock = null;
        }
      }
    });
  }

  // 尝试获取leader锁
  async acquireLeadership(): Promise<boolean> {
    try {
      // 尝试获取锁，Redlock v5 会通过 automaticExtensionThreshold 自动续期
      this.currentLock = await this.redlock.acquire([this.lockKey], this.lockTTL);
      this.isLeader = true;

      logger.info(`Pod ${this.podName} became leader`);

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
        logger.warn(`Failed to release leadership: ${(error as Error).message}`);
      } finally {
        this.currentLock = null;
        this.isLeader = false;
      }
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
    await this.releaseLeadership();
    await this.redis.quit();
    leaderElectionServiceInstance = null;
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
