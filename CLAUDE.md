# Trawler 项目

## 概述

Trawler 是面向大模型知识库的网页爬虫 API 服务，支持静态/动态网页爬取、递归爬取和内容过滤。

**技术栈：** Node.js, TypeScript, Fastify, Crawlee, Playwright, BullMQ, MongoDB, Redis
**仓库地址：** https://github.com/vissssa/trawler

## 项目结构

```
src/
├── api/
│   ├── routes.ts              # API 路由（7个端点）
│   └── server.ts              # Fastify 服务器配置
├── config/
│   └── index.ts               # 配置管理（环境变量+验证）
├── models/
│   └── Task.ts                # MongoDB Task 模型
├── services/
│   ├── database.ts            # 数据库连接服务
│   ├── leader-election.ts     # Leader 选举（Redlock）
│   └── queue.ts               # 任务队列（BullMQ）
├── utils/
│   └── logger.ts              # 日志工具（Pino）
├── worker/
│   ├── handlers.ts            # Crawlee 页面处理器
│   ├── crawler.ts             # PlaywrightCrawler 工厂
│   └── consumer.ts            # BullMQ Worker 入口
└── scheduler/
    ├── cleanup.ts             # 三种清理策略
    └── index.ts               # Scheduler 入口（Leader 选举 + 定时循环）
```

## 架构说明

系统由三个独立进程组成：

- **API** (`npm run dev:api`) — Fastify HTTP 服务，接收任务创建请求，写入 MongoDB + BullMQ 队列
- **Worker** (`npm run dev:worker`) — BullMQ Consumer，从队列取任务，用 Crawlee+Playwright 爬取网页，HTML 保存到磁盘，进度写入 MongoDB
- **Scheduler** (`npm run dev:scheduler`) — 定时清理进程，通过 Leader 选举保证单实例运行，每5分钟清理超时/孤儿/过期任务

## 常用命令

```bash
npm run build           # TypeScript 编译
npm run dev:api         # 开发模式启动 API
npm run dev:worker      # 开发模式启动 Worker
npm run dev:scheduler   # 开发模式启动 Scheduler
npm test                # 运行测试
npm run lint            # ESLint 检查
npm run format          # Prettier 格式化
```

## 关键配置项（.env）

- `MONGODB_URL` — MongoDB 连接串（默认 mongodb://localhost:27017/trawler）
- `REDIS_URL` — Redis 连接串（默认 redis://localhost:6379）
- `API_PORT` — API 端口（默认 3000）
- `WORKER_CONCURRENCY` — 页面级并发数（默认 3）
- `MAX_TASK_TIMEOUT_MS` — 任务超时毫秒（默认 7200000 = 2小时）
- `RETENTION_DAYS` — 已完成任务保留天数（默认 7）
- `DATA_DIR` — 爬取文件存储目录（默认 ./data/tasks）

## 实现进度

### ✅ 阶段1：API 基础架构（任务1-7）
- 项目初始化 + 工具链
- 配置管理 + 日志系统
- Task MongoDB 模型
- BullMQ 队列服务
- Leader 选举（Redlock）
- Fastify 服务器 + 7个 API 端点
- 服务器启动修复

### ✅ 阶段2：Worker 爬虫 + Scheduler 调度
- Bug 修复：taskId 改用 schema default 生成
- Worker handlers：HTML 提取 + MongoDB 原子更新 + 递归爬取
- Worker crawler：PlaywrightCrawler 工厂，映射 CrawlOptions（depth/pages/timeout/rateLimit/auth）
- Worker consumer：BullMQ Worker，任务生命周期管理，优雅关闭
- Scheduler cleanup：超时/孤儿/过期三种清理策略
- Scheduler index：Leader 选举 + 5分钟定时循环

### 🔲 阶段3：功能增强（待实现）
1. Worker/Scheduler 单元测试（Mock Crawlee、BullMQ、fs）
2. 文件下载端点（`GET /tasks/:taskId/files`）
3. 修复已有测试问题（API 测试的 Redis mock、路由重复注册）
4. HTML → Markdown 转换（turndown）

### 🔲 阶段4：监控与可观测性
5. Prometheus 指标端点（`GET /metrics`）
6. 结构化错误处理（自定义错误类型）

### 🔲 阶段5：部署与运维
7. Dockerfile（多阶段构建 + Playwright 预装）
8. K8s 部署配置（Deployment/Service/PVC/ConfigMap）
9. CI/CD（GitHub Actions）

### 🔲 阶段6：高级功能
10. 代理轮换
11. 内容过滤（CSS 选择器）
12. 截图 / PDF 导出

## 技术债务

| 项目 | 优先级 | 说明 |
|------|--------|------|
| server.ts lint 错误 | 高 | 4 个 unused-vars，1 个 any 警告 |
| API 测试路由重复注册 | 中 | routes.test.ts 多次 registerTaskRoutes 报错 |
| 集成测试需要 MongoDB | 中 | Task.test.ts 依赖运行中的 MongoDB |
| 配置不可变性 | 低 | config 应 Object.freeze() |

## 编码规范

- TypeScript 严格模式
- Conventional Commits（feat/fix/docs/test/refactor/chore）
- ESLint + Prettier
- 以中文回复用户
