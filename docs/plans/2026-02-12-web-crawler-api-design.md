# Web Crawler API Service 设计文档

## 概述

构建一个面向大模型知识库的网页爬取API服务，支持静态/动态网页爬取、递归爬取、内容筛选，输出为HTML文件供下游处理。

**核心特性：**
- 异步任务处理（支持批量URL）
- 自动处理静态和动态网页（统一使用Playwright）
- 递归爬取（可配置深度、URL模式）
- 内容筛选（CSS选择器、移除无关元素）
- 认证支持（Cookie/Header/Basic Auth）
- 反爬虫对抗（代理、User-Agent轮换、浏览器指纹伪装）

## 技术栈

- **框架**: Node.js + TypeScript
- **API服务**: Fastify
- **爬虫引擎**: Crawlee + Playwright
- **任务队列**: BullMQ + Redis（已有）
- **数据库**: MongoDB（已有）
- **部署**: K8s StatefulSet

## 系统架构

### 整体架构

```
用户 → API服务 (Leader选举)
        ↓
    BullMQ队列 (Redis)
        ↓
    Worker服务 (多实例并行)
        ↓
    爬取网页 → 保存HTML → 更新MongoDB
        ↓
    用户查询结果 ← API返回文件路径
```

**核心组件：**

1. **API容器** - Fastify HTTP服务，Leader选举模式
   - 接收任务创建请求，入队
   - 提供任务状态查询
   - 提供HTML文件下载
   - 端口: 3000（API）+ 9090（监控指标）

2. **Worker容器** - Crawlee爬虫引擎，多实例并行工作
   - 从BullMQ消费任务
   - 使用Playwright渲染网页
   - 提取和保存HTML内容
   - 每个Worker处理3个并发任务

3. **Scheduler容器** - 定时清理任务，Leader选举模式
   - 清理孤儿任务（Worker崩溃导致的stuck状态）
   - 超时任务检测和终止
   - 过期文件清理（7天后删除）
   - 每5分钟执行一次

4. **存储层**
   - Redis: 任务队列、Leader选举锁、Worker心跳、URL去重
   - MongoDB: 任务元数据（状态、配置、统计、错误信息）
   - 本地文件系统: `/app/data/tasks/{taskId}/{urlHash}.html`
   - PVC: ReadWriteMany共享存储（或使用BOS对象存储）

## API设计

### 1. 创建爬取任务

```http
POST /api/v1/tasks
Content-Type: application/json

{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "options": {
    "recursive": true,
    "maxDepth": 3,
    "maxPages": 100,
    "sameDomain": true,
    "urlPatterns": {
      "include": ["/docs/*", "/blog/*"],
      "exclude": ["/api/*", "/admin/*", "*.pdf"]
    },
    "contentSelector": "article.main, .content",
    "removeSelectors": [".nav", ".ads", ".footer", ".sidebar"],
    "timeout": 30000,
    "auth": {
      "type": "cookie|header|basic",
      "credentials": {
        "cookie": "session=xxx; token=yyy",
        "header": {"Authorization": "Bearer xxx"},
        "basic": {"username": "user", "password": "pass"}
      }
    },
    "proxy": "http://proxy.example.com:8080"
  }
}
```

**响应：**
```json
{
  "taskId": "task_1707721800_abc123",
  "status": "pending",
  "createdAt": "2026-02-12T10:30:00Z"
}
```

### 2. 查询任务状态

```http
GET /api/v1/tasks/{taskId}
```

**响应：**
```json
{
  "taskId": "task_1707721800_abc123",
  "status": "running",
  "progress": {
    "completed": 45,
    "total": 100,
    "failed": 2
  },
  "createdAt": "2026-02-12T10:30:00Z",
  "startedAt": "2026-02-12T10:30:05Z",
  "completedAt": null,
  "result": {
    "files": [
      {
        "url": "https://example.com/page1",
        "path": "abc123.html",
        "size": 15234,
        "statusCode": 200
      }
    ],
    "stats": {
      "success": 43,
      "failed": 2,
      "skipped": 0
    }
  },
  "error": null
}
```

**状态值：**
- `pending`: 等待处理
- `running`: 执行中
- `completed`: 已完成
- `failed`: 失败
- `timeout`: 超时

### 3. 下载HTML文件

```http
GET /api/v1/tasks/{taskId}/files/{filename}
```

返回HTML文件内容，Content-Type: text/html

### 4. 监控指标

```http
GET /metrics
```

**响应：**
```json
{
  "timestamp": "2026-02-12T10:30:00Z",
  "queue": {
    "waiting": 5,
    "active": 3,
    "completed": 120,
    "failed": 8
  },
  "worker": {
    "alive": 2,
    "activeTasks": 6
  },
  "tasks": {
    "avgDuration": 145.5,
    "successRate": 93.75,
    "totalToday": 128
  },
  "storage": {
    "diskUsage": 12.5,
    "totalFiles": 5420
  }
}
```

## 核心实现

### 1. Crawlee爬虫配置

```javascript
import { PlaywrightCrawler } from 'crawlee';

const crawler = new PlaywrightCrawler({
  maxConcurrency: 5,
  maxRequestsPerMinute: 60,
  requestHandlerTimeoutSecs: 60,
  navigationTimeoutSecs: 30,
  headless: true,
  launchContext: {
    useChrome: true,
    stealth: true  // 反爬虫检测
  },

  async requestHandler({ page, request, enqueueLinks, log }) {
    // 等待页面完全加载
    await page.waitForLoadState('networkidle');

    // 内容筛选
    let content;
    if (options.contentSelector) {
      const element = await page.locator(options.contentSelector).first();
      content = await element.innerHTML();
    } else {
      content = await page.content();
    }

    // 移除无关元素
    if (options.removeSelectors) {
      const dom = cheerio.load(content);
      options.removeSelectors.forEach(sel => dom(sel).remove());
      content = dom.html();
    }

    // 保存HTML
    const filename = crypto.createHash('md5').update(request.url).digest('hex') + '.html';
    const filepath = path.join('/app/data/tasks', taskId, filename);
    await fs.writeFile(filepath, content);

    // 记录到MongoDB
    await Task.updateOne(
      { taskId },
      {
        $push: {
          files: {
            url: request.url,
            path: filename,
            size: Buffer.byteLength(content),
            statusCode: page.status()
          }
        },
        $inc: { 'progress.completed': 1 }
      }
    );

    // 递归爬取
    if (options.recursive && currentDepth < options.maxDepth) {
      await enqueueLinks({
        strategy: 'same-domain',
        selector: 'a[href]',
        transformRequestFunction: (req) => {
          // URL模式过滤
          if (!matchUrlPattern(req.url, options.urlPatterns)) {
            return false;
          }
          req.userData = { depth: currentDepth + 1 };
          return req;
        }
      });
    }
  }
});
```

### 2. 认证处理

```javascript
// Cookie认证
if (auth.type === 'cookie') {
  const cookies = parseCookieString(auth.credentials.cookie);
  await page.context().addCookies(cookies);
}

// Header认证
if (auth.type === 'header') {
  await page.setExtraHTTPHeaders(auth.credentials.header);
}

// Basic认证
if (auth.type === 'basic') {
  await page.setHTTPCredentials(auth.credentials.basic);
}
```

### 3. 任务管理和清理

**孤儿任务检测：**
```javascript
// Scheduler每5分钟执行
async function cleanupOrphanTasks() {
  const stuckTasks = await Task.find({
    status: 'running',
    updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) }
  });

  for (const task of stuckTasks) {
    const workerId = await redis.get(`task:${task.taskId}:worker`);
    const heartbeat = await redis.get(`worker:${workerId}:heartbeat`);

    if (!heartbeat) {
      await task.updateOne({
        status: 'failed',
        error: 'Worker crashed',
        completedAt: new Date()
      });
      logger.warn(`任务 ${task.taskId} 被标记为失败（Worker失联）`);
    }
  }
}
```

**超时任务终止：**
```javascript
async function cleanupTimeoutTasks() {
  const MAX_TASK_TIMEOUT = 2 * 3600 * 1000; // 2小时

  const timeoutTasks = await Task.find({
    status: 'running',
    startedAt: { $lt: new Date(Date.now() - MAX_TASK_TIMEOUT) }
  });

  for (const task of timeoutTasks) {
    await cancelCrawlTask(task.taskId);
    await task.updateOne({
      status: 'timeout',
      error: 'Task execution timeout',
      completedAt: new Date()
    });
  }
}
```

**过期文件清理：**
```javascript
async function cleanupExpiredFiles() {
  const RETENTION_DAYS = 7;

  const expiredTasks = await Task.find({
    status: { $in: ['completed', 'failed', 'timeout'] },
    completedAt: { $lt: new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000) }
  });

  for (const task of expiredTasks) {
    const taskDir = `/app/data/tasks/${task.taskId}`;
    await fs.rm(taskDir, { recursive: true, force: true });
    await task.deleteOne();
    logger.info(`清理过期任务: ${task.taskId}`);
  }
}
```

## K8s部署

### StatefulSet配置

**3容器Sidecar模式 + Leader选举：**

- **API容器**: Leader选举，只有1个Leader提供服务，其他standby
- **Worker容器**: 全部工作，并行消费队列任务
- **Scheduler容器**: Leader选举，只有1个Leader执行定时任务

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: crawler-service
spec:
  serviceName: "crawler-service"
  replicas: 2
  selector:
    matchLabels:
      app: crawler-service
  template:
    metadata:
      labels:
        app: crawler-service
    spec:
      containers:
      - name: api
        image: your-registry/crawler-service:latest
        command: ["node", "dist/api/server.js"]
        env:
        - name: ENABLE_LEADER_ELECTION
          value: "true"
        - name: LOCK_KEY
          value: "crawler:api:leader"
        ports:
        - containerPort: 3000
        - containerPort: 9090

      - name: worker
        image: your-registry/crawler-service:latest
        command: ["node", "dist/worker/consumer.js"]
        env:
        - name: WORKER_CONCURRENCY
          value: "3"

      - name: scheduler
        image: your-registry/crawler-service:latest
        command: ["node", "dist/scheduler/index.js"]
        env:
        - name: ENABLE_LEADER_ELECTION
          value: "true"
        - name: LOCK_KEY
          value: "crawler:scheduler:leader"

      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: crawler-shared-pvc
```

### Leader选举实现

使用Redlock算法（基于Redis）实现分布式锁：

```javascript
import Redlock from 'redlock';

const redlock = new Redlock([redis]);
const LOCK_KEY = 'crawler:api:leader';
const LOCK_TTL = 10000; // 10秒

async function tryAcquireLeadership() {
  try {
    const lock = await redlock.acquire([LOCK_KEY], LOCK_TTL);
    isLeader = true;

    // 启动服务
    await app.listen({ port: 3000, host: '0.0.0.0' });

    // 定期续约
    setInterval(async () => {
      try {
        await lock.extend(LOCK_TTL);
      } catch (err) {
        isLeader = false;
        await app.close();
        setTimeout(tryAcquireLeadership, 1000);
      }
    }, LOCK_TTL / 2);

  } catch (err) {
    // Standby模式，等待成为Leader
    setTimeout(tryAcquireLeadership, 5000);
  }
}
```

### 扩容说明

```bash
# 扩容到3副本
kubectl scale statefulset crawler-service --replicas=3

# 结果：
# - API: 1个Leader + 2个standby（高可用）
# - Worker: 3个Pod × 3并发 = 9个并发任务
# - Scheduler: 1个Leader + 2个standby（高可用）
```

## 项目结构

```
crawler-service/
├── src/
│   ├── api/                    # API服务
│   │   ├── server.ts           # Fastify服务器 + Leader选举
│   │   ├── routes/
│   │   │   ├── tasks.ts        # 任务CRUD接口
│   │   │   ├── files.ts        # 文件下载接口
│   │   │   └── metrics.ts      # 监控指标接口
│   │   └── middlewares/
│   ├── worker/                 # Worker服务
│   │   ├── crawler.ts          # Crawlee配置
│   │   ├── handlers.ts         # 页面处理逻辑
│   │   └── consumer.ts         # BullMQ消费者
│   ├── scheduler/              # 定时任务服务
│   │   ├── index.ts            # Leader选举 + Cron
│   │   ├── cleanup.ts          # 清理逻辑
│   │   └── monitor.ts          # 监控逻辑
│   ├── models/
│   │   └── Task.ts             # MongoDB模型
│   ├── services/
│   │   ├── queue.ts            # BullMQ封装
│   │   ├── storage.ts          # 文件存储服务
│   │   ├── auth.ts             # 认证处理
│   │   └── leader-election.ts # Leader选举封装
│   ├── utils/
│   │   ├── logger.ts           # Pino日志配置
│   │   └── url-matcher.ts     # URL模式匹配
│   └── config/
│       └── index.ts
├── k8s/
│   ├── statefulset.yaml
│   ├── service.yaml
│   └── pvc.yaml
├── Dockerfile
├── package.json
└── tsconfig.json
```

## 监控和日志

### 日志配置

使用Pino日志库，输出到stdout供K8s收集：

```javascript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
});
```

**关键日志点：**
- 任务创建/开始/完成/失败
- 每个URL的处理结果
- Leader选举状态变化
- Worker心跳和崩溃检测
- 清理任务执行结果

### 监控指标

通过 `/metrics` 接口暴露关键指标：

- **队列状态**: 等待/执行中/已完成/失败任务数
- **Worker状态**: 存活Worker数、活跃任务数
- **任务统计**: 平均执行时长、成功率、今日任务数
- **存储状态**: 磁盘使用量、HTML文件总数

## 未来扩展

### 阶段1（当前）
- 基础任务管理（查询状态、获取结果）
- 自动清理过期文件

### 阶段2（后续迭代）
- 任务取消/暂停/恢复
- 失败页面单独重试
- 任务优先级
- 验证码识别集成
- HTML转Markdown（接入转换服务）

### 阶段3（大规模场景）
- 拆分成独立Deployment（API、Worker、Scheduler）
- Worker自动扩缩容（HPA）
- 分布式追踪（OpenTelemetry）
- 对象存储替代本地文件系统（BOS）

## 技术风险

1. **PVC共享存储**: 需要K8s集群支持ReadWriteMany，如不支持需改用BOS
2. **浏览器资源消耗**: Playwright占用内存大，需合理配置Pod资源
3. **反爬虫对抗**: 复杂验证码需外部打码平台支持
4. **任务超时控制**: 需根据实际情况调整超时参数

## 总结

本设计提供了一个灵活、可扩展的网页爬虫API服务，核心特点：

- **技术选型**: Node.js + Crawlee统一处理静态/动态网页
- **高可用**: StatefulSet + Leader选举实现主备模式
- **可扩展**: Worker多实例并行，支持水平扩展
- **可靠性**: 自动清理、心跳检测、超时控制
- **易维护**: 职责清晰，日志完善，监控指标齐全

适合作为大模型知识库的数据采集基础设施。
