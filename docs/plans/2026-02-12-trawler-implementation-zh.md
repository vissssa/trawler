# Trawler 实现计划

> **给 Claude:** 必需的子技能：使用 superpowers:executing-plans 来逐任务实现此计划。

**目标：** 构建一个用于大模型知识库内容采集的网页爬虫API服务，支持异步任务处理、递归爬取和内容过滤。

**架构：** 3服务架构（API/Worker/Scheduler），使用 Fastify + Crawlee + BullMQ，部署为 StatefulSet，API 和 Scheduler 使用 Leader 选举，Worker 并行爬取。

**技术栈：** Node.js, TypeScript, Fastify, Crawlee, Playwright, BullMQ, Redis, MongoDB

---

## 阶段 1: 项目设置和基础

### 任务 1: 初始化 TypeScript 项目

**文件：**
- 创建: `package.json`
- 创建: `tsconfig.json`
- 创建: `.gitignore`
- 创建: `.env.example`

**步骤 1: 初始化 npm 项目**

运行: `npm init -y`
预期: 创建 package.json

**步骤 2: 安装核心依赖**

```bash
npm install fastify @fastify/cors @fastify/multipart
npm install crawlee playwright
npm install bullmq ioredis
npm install mongoose
npm install pino pino-pretty
npm install redlock
npm install cheerio
npm install dotenv
```

**步骤 3: 安装开发依赖**

```bash
npm install -D typescript @types/node
npm install -D ts-node nodemon
npm install -D @types/cheerio
npm install -D jest @types/jest ts-jest
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
npm install -D prettier
```

**步骤 4: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**步骤 5: 创建 .gitignore**

```
node_modules/
dist/
.env
*.log
data/
.DS_Store
coverage/
playwright-state/
storage/
```

**步骤 6: 创建 .env.example**

```
NODE_ENV=development
LOG_LEVEL=info

# Redis
REDIS_URL=redis://localhost:6379

# MongoDB
MONGODB_URL=mongodb://localhost:27017/trawler

# API
API_PORT=3000
METRICS_PORT=9090

# Worker
WORKER_CONCURRENCY=3

# Leader Election
ENABLE_LEADER_ELECTION=false
LOCK_KEY=trawler:leader
POD_NAME=local

# Storage
DATA_DIR=./data/tasks

# Task Settings
MAX_TASK_TIMEOUT_MS=7200000
RETENTION_DAYS=7
```

**步骤 7: 添加脚本到 package.json**

```json
{
  "scripts": {
    "build": "tsc",
    "dev:api": "nodemon --exec ts-node src/api/server.ts",
    "dev:worker": "nodemon --exec ts-node src/worker/consumer.ts",
    "dev:scheduler": "nodemon --exec ts-node src/scheduler/index.ts",
    "start:api": "node dist/api/server.js",
    "start:worker": "node dist/worker/consumer.js",
    "start:scheduler": "node dist/scheduler/index.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint src --ext .ts",
    "format": "prettier --write 'src/**/*.ts'"
  }
}
```

**步骤 8: 创建目录结构**

```bash
mkdir -p src/{api/routes,worker,scheduler,models,services,utils,config}
mkdir -p tests/{api,worker,scheduler,services,utils}
mkdir -p data/tasks
mkdir -p k8s
```

**步骤 9: 提交**

```bash
git add .
git commit -m "chore: 使用依赖初始化 TypeScript 项目"
```

---

### 任务 2: 配置和日志

**文件：**
- 创建: `src/config/index.ts`
- 创建: `src/utils/logger.ts`
- 创建: `tests/utils/logger.test.ts`

**步骤 1: 编写日志测试**

```typescript
// tests/utils/logger.test.ts
import { createLogger } from '../../src/utils/logger';

describe('Logger', () => {
  it('应该创建默认级别的日志器', () => {
    const logger = createLogger('test');
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('应该创建自定义级别的日志器', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('test');
    expect(logger.level).toBe('debug');
  });
});
```

**步骤 2: 运行测试验证失败**

运行: `npm test`
预期: FAIL - 找不到 createLogger

**步骤 3: 实现日志器**

```typescript
// src/utils/logger.ts
import pino from 'pino';

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: process.env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
  });
}

export const logger = createLogger('trawler');
```

**步骤 4: 运行测试验证通过**

运行: `npm test`
预期: PASS

**步骤 5: 编写配置测试**

```typescript
// tests/config/index.test.ts
import { config } from '../../src/config';

describe('Config', () => {
  it('应该从环境变量加载配置', () => {
    expect(config.redis.url).toBeDefined();
    expect(config.mongodb.url).toBeDefined();
    expect(config.api.port).toBe(3000);
  });
});
```

**步骤 6: 实现配置**

```typescript
// src/config/index.ts
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
```

**步骤 7: 运行测试**

运行: `npm test`
预期: 所有测试 PASS

**步骤 8: 提交**

```bash
git add .
git commit -m "feat: 添加配置和日志工具"
```

---

## 阶段 2: MongoDB 模型和数据库连接

### 任务 3: Task 模型

**文件：**
- 创建: `src/models/Task.ts`
- 创建: `src/services/database.ts`
- 创建: `tests/models/Task.test.ts`

**步骤 1: 编写 Task 模型测试**

```typescript
// tests/models/Task.test.ts
import mongoose from 'mongoose';
import { Task, TaskStatus } from '../../src/models/Task';

describe('Task Model', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/trawler-test');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Task.deleteMany({});
  });

  it('应该创建带有必需字段的任务', async () => {
    const task = await Task.create({
      taskId: 'task_123',
      urls: ['https://example.com'],
      status: TaskStatus.PENDING,
      options: {},
      progress: { completed: 0, total: 0, failed: 0 },
      result: { files: [], stats: { success: 0, failed: 0, skipped: 0 } },
    });

    expect(task.taskId).toBe('task_123');
    expect(task.status).toBe(TaskStatus.PENDING);
    expect(task.createdAt).toBeDefined();
  });

  it('如果未提供应该生成唯一的 taskId', async () => {
    const task = await Task.create({
      urls: ['https://example.com'],
      options: {},
    });

    expect(task.taskId).toMatch(/^task_\d+_[a-f0-9]+$/);
  });
});
```

**步骤 2: 运行测试**

运行: `npm test Task.test`
预期: FAIL - 找不到 Task 模型

**步骤 3: 实现 Task 模型**

```typescript
// src/models/Task.ts
import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
}

export interface AuthConfig {
  type: 'cookie' | 'header' | 'basic';
  credentials: {
    cookie?: string;
    header?: Record<string, string>;
    basic?: { username: string; password: string };
  };
}

export interface CrawlOptions {
  recursive?: boolean;
  maxDepth?: number;
  maxPages?: number;
  sameDomain?: boolean;
  urlPatterns?: {
    include?: string[];
    exclude?: string[];
  };
  contentSelector?: string;
  removeSelectors?: string[];
  timeout?: number;
  auth?: AuthConfig;
  proxy?: string;
}

export interface FileResult {
  url: string;
  path: string;
  size: number;
  statusCode?: number;
}

export interface TaskDocument extends Document {
  taskId: string;
  urls: string[];
  status: TaskStatus;
  options: CrawlOptions;
  progress: {
    completed: number;
    total: number;
    failed: number;
  };
  result: {
    files: FileResult[];
    stats: {
      success: number;
      failed: number;
      skipped: number;
    };
  };
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<TaskDocument>(
  {
    taskId: {
      type: String,
      required: true,
      unique: true,
      default: () => {
        const timestamp = Date.now();
        const random = crypto.randomBytes(6).toString('hex');
        return `task_${timestamp}_${random}`;
      },
    },
    urls: {
      type: [String],
      required: true,
      validate: {
        validator: (v: string[]) => v.length > 0,
        message: '至少需要一个 URL',
      },
    },
    status: {
      type: String,
      enum: Object.values(TaskStatus),
      default: TaskStatus.PENDING,
      index: true,
    },
    options: {
      type: Schema.Types.Mixed,
      default: {},
    },
    progress: {
      completed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    result: {
      files: [
        {
          url: String,
          path: String,
          size: Number,
          statusCode: Number,
        },
      ],
      stats: {
        success: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
      },
    },
    error: String,
    startedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

taskSchema.index({ createdAt: 1 });
taskSchema.index({ completedAt: 1 });
taskSchema.index({ updatedAt: 1 });

export const Task = mongoose.model<TaskDocument>('Task', taskSchema);
```

**步骤 4: 实现数据库服务**

```typescript
// src/services/database.ts
import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../utils/logger';

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongodb.url);
    logger.info('已连接到 MongoDB');
  } catch (error) {
    logger.error({ error }, '连接 MongoDB 失败');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('已断开 MongoDB 连接');
}
```

**步骤 5: 运行测试**

运行: `npm test Task.test`
预期: 所有测试 PASS

**步骤 6: 提交**

```bash
git add .
git commit -m "feat: 添加 Task 模型和数据库服务"
```

---

## 阶段 3: BullMQ 队列服务

### 任务 4: 队列服务

**文件：**
- 创建: `src/services/queue.ts`
- 创建: `tests/services/queue.test.ts`

**步骤 1: 编写队列服务测试**

```typescript
// tests/services/queue.test.ts
import { QueueService } from '../../src/services/queue';
import Redis from 'ioredis';

describe('QueueService', () => {
  let queueService: QueueService;
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis('redis://localhost:6379');
    queueService = new QueueService(redis);
  });

  afterAll(async () => {
    await queueService.close();
    await redis.quit();
  });

  afterEach(async () => {
    await queueService.obliterate();
  });

  it('应该将任务添加到队列', async () => {
    const job = await queueService.addTask({
      taskId: 'task_123',
      urls: ['https://example.com'],
      options: {},
    });

    expect(job.id).toBeDefined();
    expect(job.data.taskId).toBe('task_123');
  });

  it('应该获取队列统计', async () => {
    await queueService.addTask({
      taskId: 'task_456',
      urls: ['https://example.com'],
      options: {},
    });

    const stats = await queueService.getQueueStats();
    expect(stats.waiting).toBeGreaterThanOrEqual(0);
    expect(stats.active).toBe(0);
  });
});
```

**步骤 2: 运行测试**

运行: `npm test queue.test`
预期: FAIL - 找不到 QueueService

**步骤 3: 实现 QueueService**

```typescript
// src/services/queue.ts
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CrawlOptions } from '../models/Task';

export interface TaskJobData {
  taskId: string;
  urls: string[];
  options: CrawlOptions;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export class QueueService {
  private queue: Queue<TaskJobData>;
  private queueEvents: QueueEvents;

  constructor(private redis: Redis) {
    this.queue = new Queue<TaskJobData>('crawl-tasks', {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 3600, // 24小时
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // 7天
        },
      },
    });

    this.queueEvents = new QueueEvents('crawl-tasks', { connection: redis });

    this.queueEvents.on('completed', ({ jobId }) => {
      logger.info({ jobId }, '任务完成');
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error({ jobId, failedReason }, '任务失败');
    });
  }

  async addTask(data: TaskJobData) {
    return this.queue.add('crawl', data, {
      jobId: data.taskId,
    });
  }

  async getQueueStats(): Promise<QueueStats> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  }

  async obliterate() {
    await this.queue.obliterate({ force: true });
  }

  async close() {
    await this.queueEvents.close();
    await this.queue.close();
  }
}

export function createQueueService(): QueueService {
  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  return new QueueService(redis);
}
```

**步骤 4: 运行测试**

运行: `npm test queue.test`
预期: 所有测试 PASS

**步骤 5: 提交**

```bash
git add .
git commit -m "feat: 使用 BullMQ 添加队列服务"
```

---

## 阶段 4: Leader 选举服务

### 任务 5: Leader 选举

**文件：**
- 创建: `src/services/leader-election.ts`
- 创建: `tests/services/leader-election.test.ts`

**步骤 1: 编写 leader 选举测试**

```typescript
// tests/services/leader-election.test.ts
import Redis from 'ioredis';
import { LeaderElection } from '../../src/services/leader-election';

describe('LeaderElection', () => {
  let redis: Redis;
  let election1: LeaderElection;
  let election2: LeaderElection;

  beforeAll(() => {
    redis = new Redis('redis://localhost:6379');
  });

  afterAll(async () => {
    await redis.quit();
  });

  afterEach(async () => {
    await election1?.release();
    await election2?.release();
  });

  it('应该获得领导权', async () => {
    election1 = new LeaderElection(redis, 'test:lock', 'pod1');

    const isLeader = await election1.tryAcquire();
    expect(isLeader).toBe(true);
    expect(election1.isLeader()).toBe(true);
  });

  it('应该阻止第二个实例获得领导权', async () => {
    election1 = new LeaderElection(redis, 'test:lock2', 'pod1');
    election2 = new LeaderElection(redis, 'test:lock2', 'pod2');

    await election1.tryAcquire();
    const isLeader2 = await election2.tryAcquire();

    expect(election1.isLeader()).toBe(true);
    expect(isLeader2).toBe(false);
  });

  it('应该释放领导权', async () => {
    election1 = new LeaderElection(redis, 'test:lock3', 'pod1');

    await election1.tryAcquire();
    expect(election1.isLeader()).toBe(true);

    await election1.release();
    expect(election1.isLeader()).toBe(false);
  });
});
```

**步骤 2: 运行测试**

运行: `npm test leader-election.test`
预期: FAIL - 找不到 LeaderElection

**步骤 3: 实现 LeaderElection**

```typescript
// src/services/leader-election.ts
import Redlock, { Lock } from 'redlock';
import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class LeaderElection {
  private redlock: Redlock;
  private lock: Lock | null = null;
  private renewInterval: NodeJS.Timeout | null = null;
  private leader = false;

  constructor(
    redis: Redis,
    private lockKey: string,
    private podName: string,
    private lockTTL: number = 10000
  ) {
    this.redlock = new Redlock([redis], {
      retryCount: 0,
      retryDelay: 200,
    });
  }

  async tryAcquire(): Promise<boolean> {
    try {
      this.lock = await this.redlock.acquire([this.lockKey], this.lockTTL);
      this.leader = true;

      logger.info(
        { podName: this.podName, lockKey: this.lockKey },
        '获得领导权'
      );

      // 启动续约间隔
      this.renewInterval = setInterval(async () => {
        await this.renew();
      }, this.lockTTL / 2);

      return true;
    } catch (error) {
      this.leader = false;
      logger.debug(
        { podName: this.podName, lockKey: this.lockKey },
        '获取领导权失败'
      );
      return false;
    }
  }

  private async renew(): Promise<void> {
    if (!this.lock) return;

    try {
      this.lock = await this.lock.extend(this.lockTTL);
      logger.debug({ podName: this.podName }, '续约领导权锁');
    } catch (error) {
      logger.error(
        { podName: this.podName, error },
        '续约锁失败，失去领导权'
      );
      this.leader = false;

      if (this.renewInterval) {
        clearInterval(this.renewInterval);
        this.renewInterval = null;
      }
    }
  }

  async release(): Promise<void> {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }

    if (this.lock) {
      try {
        await this.lock.release();
        logger.info({ podName: this.podName }, '释放领导权');
      } catch (error) {
        logger.error({ error }, '释放锁失败');
      }
      this.lock = null;
    }

    this.leader = false;
  }

  isLeader(): boolean {
    return this.leader;
  }

  async retryAcquire(intervalMs: number = 5000): Promise<void> {
    const retry = async () => {
      const acquired = await this.tryAcquire();
      if (!acquired) {
        setTimeout(retry, intervalMs);
      }
    };

    await retry();
  }
}
```

**步骤 4: 运行测试**

运行: `npm test leader-election.test`
预期: 所有测试 PASS

**步骤 5: 提交**

```bash
git add .
git commit -m "feat: 使用 Redlock 添加 leader 选举服务"
```

---

## 阶段 5: API 服务 - 基本结构

### 任务 6: Fastify 服务器设置

**文件：**
- 创建: `src/api/server.ts`
- 创建: `src/api/routes/tasks.ts`
- 创建: `tests/api/server.test.ts`

**步骤 1: 编写服务器测试**

```typescript
// tests/api/server.test.ts
import { buildServer } from '../../src/api/server';

describe('API Server', () => {
  const server = buildServer();

  afterAll(async () => {
    await server.close();
  });

  it('应该响应健康检查', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      status: 'ok',
      pod: expect.any(String),
    });
  });

  it('应该响应就绪检查', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(response.statusCode).toBe(200);
  });
});
```

**步骤 2: 运行测试**

运行: `npm test server.test`
预期: FAIL - 找不到 buildServer

**步骤 3: 实现基本服务器**

```typescript
// src/api/server.ts
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config';
import { logger } from '../utils/logger';
import { connectDatabase } from '../services/database';
import { createQueueService } from '../services/queue';
import { LeaderElection } from '../services/leader-election';
import Redis from 'ioredis';

export interface AppContext {
  queueService: ReturnType<typeof createQueueService>;
  leaderElection?: LeaderElection;
}

export function buildServer(): FastifyInstance {
  const server = Fastify({
    logger: logger as any,
  });

  server.register(cors);

  // 健康检查（始终响应）
  server.get('/health', async () => {
    return {
      status: 'ok',
      pod: config.leaderElection.podName,
    };
  });

  // 就绪检查（如果启用则感知 leader）
  server.get('/ready', async (request, reply) => {
    const ctx = server as FastifyInstance & AppContext;

    if (config.leaderElection.enabled && ctx.leaderElection) {
      if (!ctx.leaderElection.isLeader()) {
        return reply.code(503).send({
          status: 'standby',
          leader: false,
        });
      }
    }

    return { status: 'ready', leader: true };
  });

  return server;
}

export async function startServer(): Promise<FastifyInstance> {
  const server = buildServer();
  const redis = new Redis(config.redis.url);

  // 连接到数据库
  await connectDatabase();

  // 初始化队列服务
  const queueService = createQueueService();
  (server as any).queueService = queueService;

  // Leader 选举（如果启用）
  if (config.leaderElection.enabled) {
    const leaderElection = new LeaderElection(
      redis,
      config.leaderElection.lockKey,
      config.leaderElection.podName,
      config.leaderElection.lockTTL
    );

    (server as any).leaderElection = leaderElection;

    // 尝试获得领导权
    await leaderElection.retryAcquire();

    if (!leaderElection.isLeader()) {
      logger.info('以待机模式运行');
    }
  }

  // 启动服务器
  await server.listen({
    port: config.api.port,
    host: '0.0.0.0',
  });

  logger.info(`API 服务器监听端口 ${config.api.port}`);

  return server;
}

// 如果直接执行则运行
if (require.main === module) {
  startServer().catch((error) => {
    logger.error({ error }, '启动服务器失败');
    process.exit(1);
  });
}
```

**步骤 4: 运行测试**

运行: `npm test server.test`
预期: 所有测试 PASS

**步骤 5: 提交**

```bash
git add .
git commit -m "feat: 添加带健康检查的基本 Fastify 服务器"
```

---

## 阶段 6: API 路由 - 任务管理

### 任务 7: 创建任务端点

**文件：**
- 修改: `src/api/server.ts` (注册路由)
- 创建: `src/api/routes/tasks.ts`
- 创建: `tests/api/routes/tasks.test.ts`

**步骤 1: 编写创建任务测试**

```typescript
// tests/api/routes/tasks.test.ts
import { buildServer } from '../../../src/api/server';
import { Task } from '../../../src/models/Task';
import mongoose from 'mongoose';

describe('POST /api/v1/tasks', () => {
  const server = buildServer();

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/trawler-test');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await server.close();
  });

  afterEach(async () => {
    await Task.deleteMany({});
  });

  it('应该创建新任务', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        urls: ['https://example.com'],
        options: {
          recursive: false,
          maxPages: 10,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.taskId).toMatch(/^task_/);
    expect(body.status).toBe('pending');
    expect(body.createdAt).toBeDefined();
  });

  it('应该验证必需的 urls 字段', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        options: {},
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('应该验证 urls 不为空', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        urls: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
```

**步骤 2: 运行测试**

运行: `npm test tasks.test`
预期: FAIL - 找不到路由 (404)

**步骤 3: 实现 tasks 路由**

```typescript
// src/api/routes/tasks.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Task, TaskStatus, CrawlOptions } from '../../models/Task';
import { AppContext } from '../server';

interface CreateTaskBody {
  urls: string[];
  options?: CrawlOptions;
}

interface TaskParams {
  taskId: string;
}

export default async function tasksRoutes(server: FastifyInstance) {
  const ctx = server as FastifyInstance & AppContext;

  // 创建任务
  server.post<{ Body: CreateTaskBody }>(
    '/api/v1/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['urls'],
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
            },
            options: { type: 'object' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateTaskBody }>, reply: FastifyReply) => {
      const { urls, options = {} } = request.body;

      // 在数据库中创建任务
      const task = await Task.create({
        urls,
        options,
        status: TaskStatus.PENDING,
        progress: { completed: 0, total: urls.length, failed: 0 },
        result: { files: [], stats: { success: 0, failed: 0, skipped: 0 } },
      });

      // 添加到队列
      await ctx.queueService.addTask({
        taskId: task.taskId,
        urls,
        options,
      });

      return reply.code(201).send({
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
      });
    }
  );

  // 根据 ID 获取任务
  server.get<{ Params: TaskParams }>(
    '/api/v1/tasks/:taskId',
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { taskId } = request.params;

      const task = await Task.findOne({ taskId });

      if (!task) {
        return reply.code(404).send({ error: '找不到任务' });
      }

      return {
        taskId: task.taskId,
        status: task.status,
        progress: task.progress,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: task.result,
        error: task.error,
      };
    }
  );
}
```

**步骤 4: 在服务器中注册路由**

```typescript
// src/api/server.ts (在 cors 注册后添加)
import tasksRoutes from './routes/tasks';

// ... 现有代码 ...

server.register(cors);
server.register(tasksRoutes);

// ... 其余代码 ...
```

**步骤 5: 运行测试**

运行: `npm test tasks.test`
预期: 所有测试 PASS

**步骤 6: 提交**

```bash
git add .
git commit -m "feat: 添加任务创建和检索端点"
```

---

此计划继续包含 Worker、Scheduler、文件下载、监控指标和 K8s 部署的剩余任务。由于长度限制，我会先保存第一部分。

你想让我：
1. 继续完成完整的实现计划（Worker、Scheduler 等）？
2. 开始实现这第一阶段？
