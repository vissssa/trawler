# Trawler 项目

## 概述

Trawler 是面向大模型知识库的网页爬虫 API 服务，支持静态/动态网页爬取、递归爬取和内容过滤。

**技术栈：** Node.js, TypeScript, Fastify, Crawlee, Playwright, BullMQ, MongoDB, Redis

## 项目结构

```
├── .comate/rules/
│   └── trawler.mdr                # Comate 规则文件（同步自 CLAUDE.md）
├── .dockerignore                  # Docker 构建排除规则
├── Dockerfile                     # 三阶段构建（deps → builder → runtime）
├── ci.yml                         # iCode CI 流水线配置（构建 + 产出 output.tar.gz）
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
│   ├── dev.sh                     # 一键本地启动脚本（API + Worker + Scheduler）
│   └── build.sh                   # CI 构建脚本（npm ci + tsc → output/）
├── example.md                     # 使用示例文档（流程图 + 静态/动态页面完整示例）
├── example/
│   ├── mermaid-diagram-*.png      # 架构图和时序图（Mermaid 导出）
│   ├── screenshot-static.png      # 静态页面截图示例（example.com）
│   ├── screenshot-dynamic.png     # 动态页面截图示例（quotes.toscrape.com/js/）
│   ├── output-static.md           # 静态页面 Markdown 产出示例
│   └── output-dynamic.md          # 动态页面 Markdown 产出示例
├── sample-site/                   # 爬虫测试用示例网站（Express + EJS）
│   ├── app.js                     # Express 服务器入口（端口 3001）
│   ├── package.json               # 独立依赖（express, ejs, express-ejs-layouts）
│   └── views/
│       ├── layouts/main.ejs       # 页面布局模板
│       └── pages/                 # 7 类测试场景页面
│           ├── index.ejs          # 首页（场景导航）
│           ├── static/            # 静态内容（article, about）
│           ├── dynamic/           # JS 动态渲染（fetch-content, lazy-list）
│           ├── blog/              # 多层级链接（列表/详情/分类/分页）
│           ├── selectors/         # CSS 选择器过滤（mixed）
│           ├── media/             # 长页面 + 富媒体（long-page, gallery）
│           ├── edge/              # 慢响应/错误（slow, error-500, not-found）
│           └── iframe/            # iframe 嵌套（nested, embed-content）
├── docs/plans/
│   ├── IMPLEMENTATION_SUMMARY.md  # 实现总结
│   ├── 2026-02-12-trawler-implementation-zh.md
│   └── 2026-02-12-web-crawler-api-design.md
├── tests/
│   ├── api/                       # API 路由和服务器测试
│   ├── config/                    # 配置模块测试
│   ├── models/                    # MongoDB 模型测试（含 mongodb-memory-server）
│   ├── services/                  # 数据库/队列/Leader 选举测试
│   ├── utils/                     # 日志工具测试
│   ├── worker/                    # Worker handlers/crawler/consumer 测试
│   ├── scheduler/                 # Scheduler cleanup/index 测试
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
bash scripts/build.sh   # CI 构建（npm ci + tsc → output/）

# 示例网站（爬虫测试目标）
cd sample-site && npm install && npm start   # 启动测试站（端口 3001）
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

完整使用示例（含静态/动态页面爬取流程、请求/响应、产出物截图）见 [example.md](example.md)。

## 截图与 PDF 导出

创建任务时通过 `options` 启用截图和/或 PDF 导出：

```bash
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

## 示例网站（sample-site）

`sample-site/` 是一个独立的 Express + EJS 网站，作为 Trawler 爬虫的测试目标。默认端口 3001。

**测试场景覆盖：**

| 场景 | 路径 | 测试目标 |
|------|------|----------|
| 静态内容 | `/static/article`, `/static/about` | HTML→Markdown 转换、排版元素（表格/代码块/列表/引用） |
| JS 动态渲染 | `/dynamic/fetch-content`, `/dynamic/lazy-list` | Playwright 动态渲染、fetch API 加载、setTimeout 延迟渲染 |
| 多层级链接 | `/blog`, `/blog/post/:id`, `/blog/category/:name` | 递归爬取（maxDepth/maxPages）、分页、同域链接发现 |
| CSS 选择器 | `/selectors/mixed` | contentSelector 过滤（`.main-content`/`.sidebar`/`.ad-banner`） |
| 长页面 | `/media/long-page` | 截图高度降级（>16384px）|
| 富媒体 | `/media/gallery` | SVG/图片/视频/音频/Canvas |
| 慢响应/错误 | `/edge/slow?delay=ms`, `/edge/error-500`, `/edge/not-found` | 超时处理、HTTP 错误码 |
| iframe 嵌套 | `/iframe/nested` | iframe 内容隔离 |
| JSON API | `/api/posts`, `/api/quotes?delay=ms` | 供动态页面 fetch 使用 |

## 实现进度

### ✅ 阶段1：API 基础架构
- 项目初始化 + 工具链
- 配置管理 + 日志系统
- Task MongoDB 模型
- BullMQ 队列服务
- Leader 选举（Redlock）
- Fastify 服务器 + 8个 API 端点（含文件下载）

### ✅ 阶段2：Worker 爬虫 + Scheduler 调度
- Worker handlers：HTML 提取 + MongoDB 原子更新 + 递归爬取
- Worker crawler：PlaywrightCrawler 工厂，映射 CrawlOptions
- Worker consumer：BullMQ Worker，任务生命周期管理，优雅关闭
- Scheduler cleanup：超时/孤儿/过期三种清理策略
- Scheduler index：Leader 选举 + 5分钟定时循环

### ✅ 阶段3：功能增强
- Worker/Scheduler 单元测试
- HTML → Markdown 转换（turndown）
- URL 去重（API 层 + Worker 层）
- CSS 选择器内容筛选（contentSelector）
- Markdown 链接绝对化

### ✅ 阶段4：监控与可观测性
- Prometheus 指标端点（prom-client，8个自定义指标 + 默认进程指标）
- 结构化错误处理（AppError 基类 + 派生错误类）

### ✅ 阶段5：部署与运维
- Dockerfile（多阶段构建 + Playwright 预装）
- K8s 部署配置（Deployment/Service/PVC/ConfigMap/HPA）

### ✅ 阶段6：高级功能
- 代理轮换（task 级别 + 全局 PROXY_URLS）
- 内容过滤（CSS 选择器）
- 截图/PDF 导出（captureScreenshot + capturePdf）

### ✅ 阶段7：Redis 数据一致性修复
- Scheduler Redis 感知清理（stale pending + running orphan）
- 启动时一致性检查
- Prometheus 监控指标

### ✅ 阶段8：API 文档与使用示例
- Swagger UI 交互式文档（@fastify/swagger + @fastify/swagger-ui）
- example.md 使用文档（Mermaid 流程图 + 静态/动态页面示例 + 产出物截图）
- README.md 重构（职责分离：README 负责 API 参考，example.md 负责实战示例）

### ✅ 阶段9：CI/CD 与构建
- iCode CI 流水线（ci.yml，BuildCloud Node.js 22）
- 构建脚本（scripts/build.sh：npm ci + tsc → output/）
- 两层 Docker 镜像架构（base + 打包镜像）
- iCode Gerrit 代码提交
- Comate 规则同步（.comate/rules/trawler.mdr）

## 技术债务

所有已知技术债务均已修复。

## 编码规范

- TypeScript 严格模式
- Conventional Commits（feat/fix/docs/test/refactor/chore）
- ESLint + Prettier
- 以中文回复用户
