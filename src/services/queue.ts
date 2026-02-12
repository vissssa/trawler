import { Queue, QueueEvents, Job } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CrawlOptions } from '../models/Task';

// 任务数据接口
export interface CrawlJobData {
  taskId: string;
  urls: string[];
  options: CrawlOptions;
}

// 队列服务类
export class QueueService {
  private queue: Queue<CrawlJobData>;
  private queueEvents: QueueEvents;
  private connection: Redis;

  constructor() {
    // 创建 Redis 连接
    this.connection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
    });

    // 创建队列
    this.queue = new Queue<CrawlJobData>('crawl-tasks', {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 3600, // 24小时后删除完成的任务
          count: 1000, // 保留最近1000个完成的任务
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // 7天后删除失败的任务
        },
      },
    });

    // 创建队列事件监听器
    this.queueEvents = new QueueEvents('crawl-tasks', {
      connection: this.connection.duplicate(),
    });

    this.setupEventHandlers();
  }

  // 设置事件处理器
  private setupEventHandlers(): void {
    this.queueEvents.on('completed', ({ jobId }) => {
      logger.info(`Job ${jobId} completed`);
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error(`Job ${jobId} failed: ${failedReason}`);
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      logger.debug(`Job ${jobId} progress: ${JSON.stringify(data)}`);
    });
  }

  // 添加任务到队列
  async addJob(
    taskId: string,
    urls: string[],
    options: CrawlOptions = {}
  ): Promise<Job<CrawlJobData>> {
    const job = await this.queue.add(
      taskId,
      {
        taskId,
        urls,
        options,
      },
      {
        jobId: taskId,
      }
    );

    logger.info(`Added job ${taskId} to queue`);
    return job;
  }

  // 获取任务状态
  async getJob(taskId: string): Promise<Job<CrawlJobData> | undefined> {
    return this.queue.getJob(taskId);
  }

  // 移除任务
  async removeJob(taskId: string): Promise<void> {
    const job = await this.getJob(taskId);
    if (job) {
      await job.remove();
      logger.info(`Removed job ${taskId} from queue`);
    }
  }

  // 暂停队列
  async pause(): Promise<void> {
    await this.queue.pause();
    logger.info('Queue paused');
  }

  // 恢复队列
  async resume(): Promise<void> {
    await this.queue.resume();
    logger.info('Queue resumed');
  }

  // 获取队列统计信息
  async getStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  // 清理已完成的任务
  async cleanCompleted(grace: number = 0): Promise<string[]> {
    const jobs = await this.queue.clean(grace, 1000, 'completed');
    logger.info(`Cleaned ${jobs.length} completed jobs`);
    return jobs;
  }

  // 清理失败的任务
  async cleanFailed(grace: number = 0): Promise<string[]> {
    const jobs = await this.queue.clean(grace, 1000, 'failed');
    logger.info(`Cleaned ${jobs.length} failed jobs`);
    return jobs;
  }

  // 获取队列实例
  getQueue(): Queue<CrawlJobData> {
    return this.queue;
  }

  // 获取事件监听器实例
  getQueueEvents(): QueueEvents {
    return this.queueEvents;
  }

  // 关闭连接
  async close(): Promise<void> {
    await this.queue.close();
    await this.queueEvents.close();
    await this.connection.quit();
    logger.info('Queue service closed');
  }
}

// 导出单例实例
let queueServiceInstance: QueueService | null = null;

export function getQueueService(): QueueService {
  if (!queueServiceInstance) {
    queueServiceInstance = new QueueService();
  }
  return queueServiceInstance;
}
