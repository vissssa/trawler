# Trawler - 网页爬虫 API 服务

面向大模型知识库的网页爬取 API 服务。支持静态/动态网页爬取、递归爬取、HTML → Markdown 自动转换、截图/PDF 导出、内容过滤、代理轮换。

## 快速开始

### 环境要求

- Node.js >= 18
- MongoDB
- Redis

### 安装与启动

```bash
npm install
npx playwright install chromium   # 安装浏览器
cp .env.example .env              # 配置环境变量
npm run dev                       # 一键启动（API + Worker + Scheduler）
```

启动后访问：

| 地址 | 说明 |
|------|------|
| http://localhost:3000 | API 服务 |
| http://localhost:3000/docs | Swagger UI 交互式文档 |
| http://localhost:3000/health | 健康检查 |
| http://localhost:3000/metrics | Prometheus 指标 |

> **快速上手请查看 [使用示例（example.md）](example.md)**，包含静态/动态页面爬取的完整流程、请求示例和产出物截图。

### 分别启动（三个终端）

```bash
npm run dev:api         # API 服务
npm run dev:worker      # Worker 爬虫
npm run dev:scheduler   # Scheduler 定时清理
```

### 生产模式

```bash
npm run build
npm run start:api
npm run start:worker
npm run start:scheduler
```

---

## 架构

系统由三个独立进程组成：

- **API** — Fastify HTTP 服务，接收任务创建请求，写入 MongoDB + BullMQ 队列
- **Worker** — BullMQ Consumer，用 Crawlee + Playwright 爬取网页，支持 JS 动态渲染
- **Scheduler** — 定时清理进程，Leader 选举保证单实例，Redis 感知的一致性修复

> 详细架构流程图见 [example.md → 架构流程](example.md#架构流程)

---

## API 参考

> 基础地址：`http://localhost:3000`
>
> **Swagger UI**：[http://localhost:3000/docs](http://localhost:3000/docs) — 在线查看所有接口并直接发起请求

### 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/tasks` | 创建爬取任务 |
| `GET` | `/tasks` | 任务列表（分页、按状态过滤） |
| `GET` | `/tasks/:taskId` | 任务详情 |
| `GET` | `/tasks/:taskId/progress` | 任务进度 |
| `GET` | `/tasks/:taskId/files` | 下载任务文件（ZIP/单文件） |
| `PATCH` | `/tasks/:taskId` | 取消任务 |
| `DELETE` | `/tasks/:taskId` | 删除任务 |
| `GET` | `/queue/stats` | 队列统计 |
| `GET` | `/health` | 健康检查 |
| `GET` | `/metrics` | Prometheus 指标 |

### 创建任务参数（options）

| 参数               | 类型           | 默认  | 说明                                    |
| ------------------ | -------------- | ----- | --------------------------------------- |
| `maxDepth`         | number         | 无限  | 递归爬取最大深度                        |
| `maxPages`         | number         | 无限  | 最大爬取页面数                          |
| `timeout`          | number         | 30000 | 页面导航超时（毫秒）                    |
| `userAgent`        | string         | 默认  | 自定义 User-Agent                       |
| `headers`          | object         | {}    | 自定义请求头                            |
| `followRedirects`  | boolean        | true  | 是否跟随重定向                          |
| `respectRobotsTxt` | boolean        | false | 是否遵守 robots.txt                     |
| `captureScreenshot`| boolean        | false | 为每个页面生成 PNG 截图                 |
| `capturePdf`       | boolean        | false | 为每个页面生成 A4 PDF                   |
| `contentSelector`  | string/string[]| -     | CSS 选择器过滤页面内容                  |
| `proxy.urls`       | string[]       | -     | 任务级代理 URL 列表（轮询使用）         |

### 任务状态

| 状态        | 说明                     |
| ----------- | ------------------------ |
| `pending`   | 已入队，等待 Worker 处理 |
| `running`   | Worker 正在爬取中        |
| `completed` | 爬取完成                 |
| `failed`    | 爬取失败或用户取消       |
| `timeout`   | 超时被 Scheduler 标记    |

### 爬取产出

每个页面最多生成 4 种文件，保存在 `data/tasks/{taskId}/` 下：

| 类型 | MIME 类型 | 说明 |
| --- | --- | --- |
| `html` | text/html | 原始 HTML |
| `markdown` | text/markdown | HTML 转换的 Markdown |
| `screenshot` | image/png | 全页 PNG 截图（高度超 16384px 时降级为视口截图） |
| `pdf` | application/pdf | A4 尺寸 PDF（含背景色） |

文件名为 URL 的 MD5 哈希值。Markdown 由 [turndown](https://github.com/mixmark-io/turndown) 转换，适合导入大模型知识库。

> 完整请求/响应示例及产出物截图见 [example.md](example.md)

---

## 配置参考

| 环境变量              | 默认值                              | 说明                              |
| --------------------- | ----------------------------------- | --------------------------------- |
| `MONGODB_URL`         | `mongodb://localhost:27017/trawler` | MongoDB 连接串                    |
| `REDIS_URL`           | `redis://localhost:6379`            | Redis 连接串                      |
| `API_PORT`            | `3000`                              | API 服务端口                      |
| `WORKER_CONCURRENCY`  | `3`                                 | 页面级并发数                      |
| `MAX_TASK_TIMEOUT_MS` | `7200000`                           | 任务超时（默认2小时）             |
| `RETENTION_DAYS`      | `7`                                 | 已完成任务保留天数                |
| `DATA_DIR`            | `./data/tasks`                      | 爬取文件存储目录                  |
| `LOG_DIR`             | `./logs`                            | 日志文件目录                      |
| `LOG_LEVEL`           | `info`                              | 日志级别（debug/info/warn/error） |
| `NODE_ENV`            | `development`                       | 环境（development 有彩色日志）    |
| `PROXY_URLS`          | -                                   | 全局代理 URL 列表（逗号分隔）    |
| `CORS_ORIGINS`        | `*`                                 | CORS 允许域（逗号分隔）          |
| `TRUST_PROXY`         | `false`                             | 是否信任反向代理                  |

---

## 运维

### 日志

日志同时输出到控制台和 `logs/` 目录：

```
logs/
├── api.log
├── worker.log
└── scheduler.log
```

### 优雅关闭

按 `Ctrl+C` 停止服务。各进程收到 `SIGINT`/`SIGTERM` 后：

- **API**：关闭 HTTP 监听，等待请求完成
- **Worker**：停止接收新任务，等待当前爬取完成
- **Scheduler**：释放 Leader 锁，关闭 Redis 连接

---

## 技术栈

| 组件 | 技术 |
|------|------|
| API 框架 | Fastify |
| 爬虫引擎 | Crawlee + Playwright |
| 任务队列 | BullMQ + Redis |
| 数据库 | MongoDB (Mongoose) |
| 日志 | Pino |
| 监控 | Prometheus (prom-client) |
| 语言 | TypeScript |

## License

MIT
