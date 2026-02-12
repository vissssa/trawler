import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  mongodb: {
    url: process.env.MONGODB_URL || 'mongodb://localhost:27017/trawler',
  },

  api: {
    port: parseInt(process.env.API_PORT || '3000', 10),
    metricsPort: parseInt(process.env.METRICS_PORT || '9090', 10),
  },

  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
  },

  leaderElection: {
    enabled: process.env.ENABLE_LEADER_ELECTION === 'true',
    lockKey: process.env.LOCK_KEY || 'trawler:leader',
    lockTTL: 10000, // 10秒
    podName: process.env.POD_NAME || 'local',
  },

  storage: {
    dataDir: process.env.DATA_DIR || './data/tasks',
  },

  task: {
    maxTimeoutMs: parseInt(process.env.MAX_TASK_TIMEOUT_MS || '7200000', 10),
    retentionDays: parseInt(process.env.RETENTION_DAYS || '7', 10),
  },
};
