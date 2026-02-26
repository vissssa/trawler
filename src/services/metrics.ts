import client from 'prom-client';
import { Task, TaskStatus } from '../models/Task';
import { getQueueService } from './queue';

// 自定义 Registry
export const metricsRegistry = new client.Registry();

// 收集默认进程指标（内存/CPU/事件循环等）
client.collectDefaultMetrics({ register: metricsRegistry });

// 任务计数器 — 按 status 标签统计创建的任务
export const tasksTotal = new client.Counter({
  name: 'trawler_tasks_total',
  help: 'Total number of tasks created, labeled by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

// 当前任务数量 — 每次 scrape 时从 MongoDB 查询
export const tasksCurrent = new client.Gauge({
  name: 'trawler_tasks_current',
  help: 'Current number of tasks by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
  async collect() {
    try {
      const statuses = Object.values(TaskStatus);
      const counts = await Promise.all(
        statuses.map((s) => Task.countDocuments({ status: s }))
      );
      statuses.forEach((s, i) => {
        this.set({ status: s }, counts[i]);
      });
    } catch {
      // ignore errors during metric collection
    }
  },
});

// 队列深度
export const queueDepth = new client.Gauge({
  name: 'trawler_queue_depth',
  help: 'Queue depth by state (waiting/active/completed/failed/delayed)',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
  async collect() {
    try {
      const stats = await getQueueService().getStats();
      this.set({ state: 'waiting' }, stats.waiting);
      this.set({ state: 'active' }, stats.active);
      this.set({ state: 'completed' }, stats.completed);
      this.set({ state: 'failed' }, stats.failed);
      this.set({ state: 'delayed' }, stats.delayed);
    } catch {
      // ignore errors during metric collection
    }
  },
});

// HTTP 请求延迟 histogram
export const httpRequestDuration = new client.Histogram({
  name: 'trawler_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// 爬取页面计数
export const pagesCrawledTotal = new client.Counter({
  name: 'trawler_pages_crawled_total',
  help: 'Total pages crawled, labeled by result (success/failed)',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});
