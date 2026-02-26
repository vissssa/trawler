# Trawler 项目

## 概述

Trawler 是面向大模型知识库的网页爬虫 API 服务，支持静态/动态网页爬取、递归爬取和内容过滤。

**技术栈：** Node.js, TypeScript, Fastify, Crawlee, Playwright, BullMQ, MongoDB, Redis
**仓库地址：** https://github.com/vissssa/trawler

## 项目结构

```
├── .dockerignore                  # Docker 构建排除规则
├── Dockerfile                     # 三阶段构建（deps → builder → runtime）
├── build/
│   ├── base/
│   │   ├── Dockerfile.amd64       # amd64 base 镜像（node:22-slim + Playwright Chromium）
│   │   └── Dockerfile.arm64       # arm64 base 镜像（node:22-slim + Playwright Chromium）
│   ├── Dockerfile.amd64           # amd64 打包镜像（FROM base + COPY output/）
│   └── Dockerfile.arm64           # arm64 打包镜像（FROM base + COPY output/）
├── k8s/
│   ├── configmap.yaml             # 非敏感环境变量
│   ├── secret.yaml                # 敏感配置模板（MongoDB/Redis URL）
│   ├── pvc.yaml                   # 持久卷（50Gi RWX）
│   ├── api.yaml                   # API Deployment + ClusterIP Service
│   ├── worker.yaml                # Worker Deployment
│   ├── scheduler.yaml             # Scheduler Deployment
│   └── hpa.yaml                   # HPA（API + Worker 自动扩缩）
├── scripts/
│   └── dev.sh                     # 一键本地启动脚本（API + Worker + Scheduler）
├── tests/
│   └── integration/
│       ├── api-e2e.ts             # API 集成测试（22 组，72 断言）
│       └── crawl-e2e.ts           # 端到端爬虫流程测试（10 步，38 断言）
└── src/
    ├── api/
    │   ├── routes.ts              # API 路由（9个端点，含 /metrics）
    │   └── server.ts              # Fastify 服务器配置（含 Swagger UI）
    ├── config/
    │   └── index.ts               # 配置管理（环境变量+验证）
    ├── errors/
    │   └── index.ts               # 结构化错误类（AppError/NotFoundError/BadRequestError/ConflictError）
    ├── models/
    │   └── Task.ts                # MongoDB Task 模型
    ├── services/
    │   ├── database.ts            # 数据库连接服务
    │   ├── leader-election.ts     # Leader 选举（Redlock）
    │   ├── metrics.ts             # Prometheus 指标（prom-client）
    │   └── queue.ts               # 任务队列（BullMQ）
    ├── utils/
    │   ├── logger.ts              # 日志工具（Pino，统一 rootLogger）
    │   └── validation.ts          # 共享校验工具（taskId、路径安全）
    ├── worker/
    │   ├── handlers.ts            # Crawlee 页面处理器 + HTML→Markdown 转换 + 截图/PDF
    │   ├── crawler.ts             # PlaywrightCrawler 工厂（含代理轮换）
    │   └── consumer.ts            # BullMQ Worker 入口
    └── scheduler/
        ├── cleanup.ts             # 五种清理策略（含 Redis 感知的 pending/running 一致性修复）
        └── index.ts               # Scheduler 入口（Leader 选举 + QueueService + 定时循环）
```

## 架构说明

系统由三个独立进程组成：

- **API** (`npm run dev:api`) — Fastify HTTP 服务，接收任务创建请求，写入 MongoDB + BullMQ 队列，内置 Swagger UI 交互式文档（`/docs`）
- **Worker** (`npm run dev:worker`) — BullMQ Consumer，从队列取任务，用 Crawlee+Playwright 爬取网页，HTML 保存到磁盘，进度写入 MongoDB
- **Scheduler** (`npm run dev:scheduler`) — 定时清理进程，通过 Leader 选举保证单实例运行，每5分钟执行五种清理策略（Redis 感知的 stale-pending/running-orphan 修复 + 超时/孤儿/过期清理），启动时自动执行一次一致性检查

## 常用命令

```bash
npm run build           # TypeScript 编译
npm run dev             # 一键启动 API + Worker + Scheduler（本地开发）
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
- `PROXY_URLS` — 全局代理 URL 列表，逗号分隔（可选）
- `PENDING_STALE_MS` — pending 任务超过此时间且 Redis 无对应 job 视为孤儿（默认 1800000 = 30分钟）
- `RUNNING_ORPHAN_CHECK_MS` — running 任务超过此时间且 Redis 无对应 job 立即标记失败（默认 600000 = 10分钟）
- `STALE_PENDING_ACTION` — 孤儿 pending 任务处理方式：`reenqueue`（重新入队，默认）或 `fail`（标记失败）

## API 文档

启动服务后访问 Swagger UI 交互式文档：

- **Swagger UI**：`http://localhost:3000/docs`
- **OpenAPI JSON**：`http://localhost:3000/docs/json`

所有端点按 `Tasks`（任务管理）和 `System`（健康检查与监控）两个 tag 分组，支持在页面内直接发起请求（Try it out）。

## 截图与 PDF 导出

创建任务时通过 `options` 启用截图和/或 PDF 导出：

```bash
# 创建包含截图和 PDF 的爬取任务
curl -X POST http://localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "urls": ["https://example.com"],
    "options": {
      "captureScreenshot": true,
      "capturePdf": true,
      "maxDepth": 2,
      "maxPages": 10
    }
  }'
```

**支持的选项：**

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `captureScreenshot` | boolean | false | 每个页面生成全页 PNG 截图（高度超过 16384px 时自动降级为视口截图） |
| `capturePdf` | boolean | false | 每个页面生成 A4 尺寸 PDF（含背景色） |

**文件下载与过滤：**

```bash
# 下载全部文件（ZIP）
curl -O http://localhost:3000/tasks/{taskId}/files

# 按类型过滤下载
curl -O http://localhost:3000/tasks/{taskId}/files?type=screenshot   # 仅截图
curl -O http://localhost:3000/tasks/{taskId}/files?type=pdf          # 仅 PDF
curl -O http://localhost:3000/tasks/{taskId}/files?type=html         # 仅 HTML
curl -O http://localhost:3000/tasks/{taskId}/files?type=markdown     # 仅 Markdown

# 单文件下载（仅当过滤后只有 1 个文件时可用）
curl -O http://localhost:3000/tasks/{taskId}/files?type=screenshot&format=single
```

**任务结果中的文件类型：**

每个爬取的页面最多生成 4 种文件，可通过 `GET /tasks/{taskId}` 的 `result.files` 查看：

| 文件类型 | MIME 类型 | 说明 |
|----------|-----------|------|
| `html` | text/html | 原始 HTML |
| `markdown` | text/markdown | 由 HTML 转换的 Markdown |
| `screenshot` | image/png | 页面全屏截图 |
| `pdf` | application/pdf | A4 PDF 导出 |

## 实现进度

### ✅ 阶段1：API 基础架构（任务1-7）
- 项目初始化 + 工具链
- 配置管理 + 日志系统
- Task MongoDB 模型
- BullMQ 队列服务
- Leader 选举（Redlock）
- Fastify 服务器 + 8个 API 端点（含文件下载）
- 服务器启动修复

### ✅ 阶段2：Worker 爬虫 + Scheduler 调度
- Bug 修复：taskId 改用 schema default 生成
- Worker handlers：HTML 提取 + MongoDB 原子更新 + 递归爬取
- Worker crawler：PlaywrightCrawler 工厂，映射 CrawlOptions（depth/pages/timeout/rateLimit/auth）
- Worker consumer：BullMQ Worker，任务生命周期管理，优雅关闭
- Scheduler cleanup：超时/孤儿/过期三种清理策略
- Scheduler index：Leader 选举 + 5分钟定时循环

### ✅ 阶段2.5：运维优化
- 日志系统：双输出（控制台 + 文件），每进程一个日志文件（api.log/worker.log/scheduler.log）
- Leader 选举修复：移除手动 setInterval 续期，改用 Redlock v5 内置 automaticExtensionThreshold
- 各服务模块使用命名 logger（database/queue/leader-election/api/api:routes）
- 端到端验证：API → BullMQ → Worker → Crawlee+Playwright → 文件保存 → MongoDB 更新

### ✅ 阶段3：功能增强
1. ~~Worker/Scheduler 单元测试（Mock Crawlee、BullMQ、fs）~~ ✅
2. ~~文件下载端点（`GET /tasks/:taskId/files`）~~ ✅
3. ~~修复已有测试问题（API 测试的 Redis mock、路由重复注册）~~ ✅
4. ~~HTML → Markdown 转换（turndown）~~ ✅
5. ~~URL 去重（API 层 `new Set` + Worker 层 Crawlee RequestQueue 内建去重）~~ ✅
6. ~~CSS 选择器内容筛选（`contentSelector` 选项，cheerio 提取）~~ ✅
7. ~~Markdown 链接绝对化（cheerio 遍历 `[href]`/`[src]`，`new URL` 转绝对）~~ ✅

### ✅ 阶段4：监控与可观测性
5. ~~Prometheus 指标端点（`GET /metrics`）~~ ✅（prom-client，8个自定义指标 + 默认进程指标）
6. ~~结构化错误处理（自定义错误类型）~~ ✅（AppError 基类 + NotFoundError/BadRequestError/ConflictError/InternalError）

### ✅ 阶段5：部署与运维（部分完成）
7. ~~Dockerfile（多阶段构建 + Playwright 预装）~~ ✅
8. ~~K8s 部署配置（Deployment/Service/PVC/ConfigMap/HPA）~~ ✅
9. ~~CI/CD（GitHub Actions）~~ — 不需要

### ✅ 阶段6：高级功能（部分完成）
10. ~~代理轮换~~ ✅（task 级别 + 全局 PROXY_URLS，Crawlee ProxyConfiguration round-robin）
11. ~~内容过滤（CSS 选择器）~~ ✅（通过 `contentSelector` 实现）
12. ~~截图 / PDF 导出~~ ✅（`captureScreenshot` PNG + `capturePdf` A4 PDF）

### ✅ 阶段7：Redis 数据一致性修复
13. ~~Scheduler Redis 感知清理~~ ✅（stale pending 任务检测 + 重新入队/标记失败，running 任务 Redis 孤儿检测）
14. ~~启动时一致性检查~~ ✅（Scheduler 启动后立即执行一次全量清理，快速修复 Redis 重装/清空后的数据不一致）
15. ~~Prometheus 监控指标~~ ✅（`stale_pending_reconciled_total` + `running_orphaned_by_redis_total`）

### ✅ 阶段8：API 文档
16. ~~Swagger UI 交互式文档~~ ✅（`@fastify/swagger` + `@fastify/swagger-ui`，`/docs` 路径，全部端点含 tags/summary/description，POST /tasks 含参数说明和 Try it out 示例）

## 技术债务

| 项目 | 优先级 | 说明 |
|------|--------|------|
| ~~server.ts lint 错误~~ | ~~高~~ | ✅ 已修复：unused-vars 加 `_` 前缀，`as any` 改用 `FastifyError` 泛型 |
| ~~API 测试路由重复注册~~ | ~~中~~ | ✅ 已修复：routes.test.ts 移除多余的 registerTaskRoutes 调用 |
| ~~集成测试需要 MongoDB~~ | ~~中~~ | ✅ 已修复：Task.test.ts 改用 mongodb-memory-server |
| ~~配置不可变性~~ | ~~低~~ | ✅ 已修复：config 及嵌套对象均 Object.freeze() |

## 编码规范

- TypeScript 严格模式
- Conventional Commits（feat/fix/docs/test/refactor/chore）
- ESLint + Prettier
- 以中文回复用户
