# Trawler 项目实现总结

## 项目概述

Trawler 是一个面向大模型知识库的网页爬虫 API 服务，支持静态/动态网页爬取、递归爬取和内容过滤。

**技术栈：** Node.js, TypeScript, Fastify, Crawlee, Playwright, BullMQ, MongoDB, Redis

**仓库地址：** https://github.com/vissssa/trawler

## 实现进度

### 阶段1：API 基础架构 ✅ 已完成

| 任务 | 状态 | Commit | 说明 |
|------|------|--------|------|
| 任务1 | ✅ | 24dfde7, ae96351 | 初始化 TypeScript 项目 + 工具链配置 |
| 任务2 | ✅ | b843bdf, f39674d | 配置管理 + 日志系统（带验证） |
| 任务3 | ✅ | 0c38ff0 | Task 模型 + 数据库服务 |
| 任务4 | ✅ | 6724a3b | BullMQ 队列服务 |
| 任务5 | ✅ | 1feeffe | Leader 选举服务（Redlock） |
| 任务6 | ✅ | 9549831 | Fastify 服务器设置 |
| 任务7 | ✅ | 0984e1b | 任务管理 API 端点 |
| 修复 | ✅ | 84a3afd | 服务器启动入口 + 路由注册 |

### 阶段2：Worker 爬虫 + Scheduler 调度 ✅ 已完成

| 任务 | 状态 | Commit | 说明 |
|------|------|--------|------|
| Bug 修复 | ✅ | ee4ef76 | taskId 改用 schema default 生成，移除 pre('save') hook |
| Worker handlers | ✅ | ee4ef76 | Crawlee 页面处理器，HTML 提取 + MongoDB 原子更新 |
| Worker crawler | ✅ | ee4ef76 | PlaywrightCrawler 工厂，完整映射 CrawlOptions |
| Worker consumer | ✅ | ee4ef76 | BullMQ Worker 入口，任务消费 + 生命周期管理 |
| Scheduler cleanup | ✅ | ee4ef76 | 超时/孤儿/过期任务三种清理策略 |
| Scheduler index | ✅ | ee4ef76 | Leader 选举 + 5分钟定时清理循环 |

### Git 提交历史

```
ee4ef76 feat: 实现 Worker 爬虫引擎和 Scheduler 定时清理
dd2d485 docs: 更新项目进度和生产环境配置状态
84a3afd fix: 添加服务器启动入口和路由注册
bf3150c docs: 添加项目实现总结文档
0984e1b feat: 实现任务管理 API 端点 (任务7)
9549831 feat: 实现 Fastify 服务器设置 (任务6)
1feeffe feat: 实现 Leader 选举服务 (任务5)
6724a3b feat: 实现 BullMQ 队列服务 (任务4)
0c38ff0 feat: 添加 Task 模型和数据库服务
f39674d fix: 添加配置验证和日志级别验证
b843bdf feat: 添加配置和日志工具
ae96351 fix: 添加工具链配置文件并修复依赖问题
24dfde7 chore: 使用依赖初始化 TypeScript 项目
```

## 项目结构

```
trawler/
├── src/
│   ├── api/
│   │   ├── routes.ts              # API 路由（7个端点）
│   │   └── server.ts              # Fastify 服务器配置
│   ├── config/
│   │   └── index.ts               # 配置管理（环境变量+验证）
│   ├── models/
│   │   └── Task.ts                # MongoDB Task 模型
│   ├── services/
│   │   ├── database.ts            # 数据库连接服务
│   │   ├── leader-election.ts     # Leader 选举（Redlock）
│   │   └── queue.ts               # 任务队列（BullMQ）
│   ├── utils/
│   │   └── logger.ts              # 日志工具（Pino）
│   ├── worker/
│   │   ├── handlers.ts            # Crawlee 页面处理器
│   │   ├── crawler.ts             # PlaywrightCrawler 工厂
│   │   └── consumer.ts            # BullMQ Worker 入口
│   └── scheduler/
│       ├── cleanup.ts             # 三种清理策略
│       └── index.ts               # Scheduler 入口（Leader 选举 + 定时循环）
├── tests/                         # 测试文件（9个）
├── docs/plans/                    # 设计文档
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## 已实现功能详情

### 1. 配置管理 (`src/config/index.ts`)
- 环境变量加载（dotenv）
- 配置验证（数值范围、类型检查）
- 默认值处理
- 配置分组：redis, mongodb, api, worker, leaderElection, storage, task

### 2. 日志系统 (`src/utils/logger.ts`)
- 基于 Pino 的高性能日志
- 双输出：控制台（pino-pretty）+ 文件（singleLine 格式）
- 每进程一个日志文件：api.log / worker.log / scheduler.log
- 各模块使用命名 logger（database/queue/leader-election/api/api:routes）
- 日志级别通过 `LOG_LEVEL` 环境变量配置

### 3. Task 模型 (`src/models/Task.ts`)
- 完整的 MongoDB Schema，含 TaskStatus 枚举（PENDING, RUNNING, COMPLETED, FAILED, TIMEOUT）
- 自动生成唯一 taskId（`task_{timestamp}_{random}`）— 通过 schema default 实现
- 完整类型定义：AuthConfig, CrawlOptions, FileResult, TaskProgress, TaskResult
- 索引优化：taskId 唯一索引，status+createdAt 复合索引

### 4. 队列服务 (`src/services/queue.ts`)
- BullMQ 任务队列，队列名 `crawl-tasks`
- 自动重试（3次，指数退避 5s 起）
- 任务自动清理（完成 24h / 失败 7d 后）
- 队列统计、暂停/恢复、事件监听

### 5. Leader 选举 (`src/services/leader-election.ts`)
- 基于 Redlock 的分布式锁，TTL 60s
- 使用 Redlock v5 内置 `automaticExtensionThreshold` 自动续期
- Leader 故障自动转移
- 优雅释放

### 6. Fastify 服务器 (`src/api/server.ts`)
- CORS、Multipart（10MB）
- 请求日志 + requestId
- 全局错误处理（验证错误、404、500）
- 健康检查 `/health`、就绪检查 `/ready`
- 优雅关闭

### 7. API 端点 (`src/api/routes.ts`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/tasks` | POST | 创建爬取任务，自动入队 BullMQ |
| `/tasks/:taskId` | GET | 获取任务详情 |
| `/tasks` | GET | 分页列出任务，支持 status 筛选 |
| `/tasks/:taskId` | PATCH | 更新任务状态 |
| `/tasks/:taskId` | DELETE | 删除任务（数据库 + 队列） |
| `/tasks/:taskId/progress` | GET | 获取任务实时进度 |
| `/queue/stats` | GET | 获取队列统计 |

### 8. Worker 爬虫引擎 (`src/worker/`)

**handlers.ts — 页面处理器：**
- `createRequestHandler(taskId)` — 提取 HTML，保存到 `{dataDir}/{taskId}/{md5(url)}.html`
- 使用 `Task.updateOne` + `$inc/$push` 原子更新进度和文件列表
- `enqueueLinks({ strategy: 'same-domain' })` 支持递归爬取
- `createFailedRequestHandler(taskId)` — 记录失败 URL 到 MongoDB

**crawler.ts — PlaywrightCrawler 工厂：**
- CrawlOptions → Crawlee 配置映射：maxDepth, maxPages, timeout, rateLimit, userAgent, headers
- 认证支持：basic, bearer, cookie（通过 preNavigationHooks）
- 每个任务独立 `Configuration`，`persistStorage: false`
- headless Playwright + `--no-sandbox`

**consumer.ts — BullMQ Worker 入口：**
- 消费 `crawl-tasks` 队列
- 任务生命周期：PENDING → RUNNING → COMPLETED/FAILED
- Worker 并发 1（任务级），Crawlee 内部处理页面级并发
- `lockDuration: 300000ms`（5分钟）
- 优雅关闭（SIGINT/SIGTERM）

### 9. Scheduler 清理服务 (`src/scheduler/`)

**cleanup.ts — 三种清理策略：**
- `cleanupTimedOutTasks()` — RUNNING 超过 `maxTimeoutMs` → TIMEOUT
- `cleanupOrphanedTasks()` — updatedAt 超时（2x maxTimeoutMs）→ TIMEOUT（Worker 崩溃场景）
- `cleanupExpiredTasks()` — 超过 `retentionDays` 的已完成/失败任务：删除文件 + 删除记录

**index.ts — Scheduler 入口：**
- Leader 选举，只有 Leader 执行清理
- 每 5 分钟执行一次清理循环
- 优雅关闭

## 项目统计

| 指标 | 数值 |
|------|------|
| 源文件 | 13 个 |
| 测试文件 | 9 个 |
| 源代码行数 | ~1,700 行 |
| 单元测试 | 46 个通过 |
| TypeScript 编译 | 0 错误 |
| ESLint（新代码） | 0 错误 |

## 运行指南

### 环境要求
- Node.js >= 18
- MongoDB
- Redis

### 安装

```bash
npm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env，配置 MONGODB_URL 和 REDIS_URL
```

### 开发模式

```bash
# 三个服务分别启动
npm run dev:api         # API 服务（Fastify）
npm run dev:worker      # Worker 服务（Crawlee 爬虫）
npm run dev:scheduler   # Scheduler 服务（定时清理）
```

### 生产模式

```bash
npm run build
npm run start:api
npm run start:worker
npm run start:scheduler
```

### 测试

```bash
npm test                # 全部测试
npm run lint            # ESLint 检查
npm run format          # Prettier 格式化
```

## 后续待实现功能

### 阶段3：功能增强（优先级高）

1. **Worker/Scheduler 单元测试**
   - 为 `src/worker/` 和 `src/scheduler/` 编写单元测试
   - Mock Crawlee、BullMQ、文件系统

2. **文件下载端点**
   - `GET /tasks/:taskId/files` — 列出任务爬取的文件
   - `GET /tasks/:taskId/files/:filename` — 下载指定文件

3. **修复已有测试问题**
   - `tests/api/server.test.ts` 和 `tests/api/routes.test.ts` 中的 Redis mock 问题
   - 重复路由注册 bug

4. **HTML → Markdown 转换**
   - 集成 turndown 或类似库
   - 为大模型知识库提供更干净的文本格式

### 阶段4：监控与可观测性（优先级中）

5. **Prometheus 指标端点**
   - `GET /metrics` — 任务统计、队列深度、爬取速率
   - Worker 心跳监控

6. **结构化错误处理**
   - 自定义错误类型（TaskNotFoundError, CrawlError 等）
   - 统一错误响应格式

### 阶段5：部署与运维（优先级中）

7. **Dockerfile**
   - 多阶段构建
   - Playwright 浏览器预装
   - 镜像大小优化

8. **K8s 部署配置**
   - API: Deployment + Service
   - Worker: Deployment（可水平扩展）
   - Scheduler: Deployment（单副本 + Leader 选举）
   - ConfigMap / Secret
   - PVC（数据存储）

9. **CI/CD**
   - GitHub Actions: 自动测试 + 构建
   - Docker 镜像推送
   - K8s 自动部署

### 阶段6：高级功能（优先级低）

10. **代理轮换**
    - 支持配置代理池
    - 自动轮换和失败切换

11. **内容过滤**
    - CSS 选择器提取
    - 移除广告/导航等无关元素

12. **截图功能**
    - 页面截图保存
    - 支持全页面和视口截图

13. **PDF 导出**
    - 页面导出为 PDF

## 技术债务

| 项目 | 优先级 | 说明 |
|------|--------|------|
| server.ts lint 错误 | 高 | 4 个 unused-vars 错误，1 个 any 警告 |
| 配置不可变性 | 中 | config 对象应使用 `Object.freeze()` |
| 集成测试 MongoDB 依赖 | 中 | Task.test.ts 需要运行中的 MongoDB |
| API 测试路由重复注册 | 中 | routes.test.ts 多次调用 registerTaskRoutes 导致报错 |

---

**最后更新：** 2026-02-25
**版本：** 0.2.0
**状态：** 核心功能已完成（API + Worker + Scheduler），端到端流程已验证通过
