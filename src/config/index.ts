import dotenv from 'dotenv';

dotenv.config();

function parseIntWithValidation(
  value: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (isNaN(parsed)) {
    console.warn(`Invalid integer value: ${value}, using default: ${defaultValue}`);
    return defaultValue;
  }
  if (min !== undefined && parsed < min) {
    console.warn(`Value ${parsed} is below minimum ${min}, using default: ${defaultValue}`);
    return defaultValue;
  }
  if (max !== undefined && parsed > max) {
    console.warn(`Value ${parsed} exceeds maximum ${max}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

export const config = {
  env: process.env.NODE_ENV || 'development',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  mongodb: {
    url: process.env.MONGODB_URL || 'mongodb://localhost:27017/trawler',
  },

  api: {
    port: parseIntWithValidation(process.env.API_PORT, 3000, 1024, 65535),
    metricsPort: parseIntWithValidation(process.env.METRICS_PORT, 9090, 1024, 65535),
  },

  worker: {
    concurrency: parseIntWithValidation(process.env.WORKER_CONCURRENCY, 3, 1, 100),
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
    maxTimeoutMs: parseIntWithValidation(process.env.MAX_TASK_TIMEOUT_MS, 7200000, 1000),
    retentionDays: parseIntWithValidation(process.env.RETENTION_DAYS, 7, 1, 365),
  },
};
