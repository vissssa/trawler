# Trawler - 网页爬虫 API 服务

面向大模型知识库的网页爬取 API 服务。支持静态/动态网页爬取、递归爬取、HTML → Markdown 自动转换、截图/PDF 导出、内容过滤、代理轮换。

## 快速开始

### 环境要求

- Node.js >= 18
- MongoDB
- Redis

### 安装

```bash
npm install
npx playwright install chromium   # 安装浏览器
```

### 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
MONGODB_URL=mongodb://localhost:27017/trawler
REDIS_URL=redis://localhost:6379
API_PORT=3000
WORKER_CONCURRENCY=3
LOG_LEVEL=info
```

### 启动服务

```bash
# 一键启动所有服务（API + Worker + Scheduler），Ctrl+C 停止
npm run dev
```

或分别启动（三个终端窗口）：

```bash
# 终端 1：API 服务
npm run dev:api

# 终端 2：Worker 爬虫
npm run dev:worker

# 终端 3：Scheduler 定时清理
npm run dev:scheduler
```

生产模式：

```bash
npm run build
npm run start:api
npm run start:worker
npm run start:scheduler
```

### 停止服务

各进程支持优雅关闭，按 `Ctrl+C` 即可停止。服务收到 `SIGINT` / `SIGTERM` 后会：

- API：关闭 HTTP 监听，等待请求完成
- Worker：停止接收新任务，等待当前爬取完成
- Scheduler：释放 Leader 锁，关闭 Redis 连接

### 日志文件

日志同时输出到控制台和 `logs/` 目录，每个服务进程一个日志文件：

```
logs/
├── api.log          # API 服务日志
├── worker.log       # Worker 爬虫日志
└── scheduler.log    # Scheduler 清理日志
```

实时查看日志：

```bash
tail -f logs/api.log
tail -f logs/worker.log
tail -f logs/scheduler.log
```

---

## API 使用文档

> 基础地址：`http://localhost:3000`
>
> **交互式文档（Swagger UI）**：[http://localhost:3000/docs](http://localhost:3000/docs) — 可在线查看所有接口定义并直接发起请求
>
> **OpenAPI JSON**：`http://localhost:3000/docs/json`

### 1. 创建爬取任务

```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com"],
    "options": {
      "maxPages": 10
    }
  }'
```

**响应：**

```json
{
  "taskId": "task_1772000189593_47731b84",
  "status": "pending",
  "urls": ["https://example.com"],
  "createdAt": "2026-02-25T06:16:29.596Z"
}
```

#### 完整 options 参数

```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com", "https://example.org"],
    "options": {
      "maxDepth": 3,
      "maxPages": 100,
      "timeout": 30000,
      "userAgent": "MyBot/1.0",
      "headers": {
        "Accept-Language": "zh-CN"
      },
      "followRedirects": true,
      "respectRobotsTxt": true,
      "captureScreenshot": true,
      "capturePdf": true,
      "contentSelector": "article",
      "proxy": {
        "urls": ["http://proxy1:8080", "http://proxy2:8080"]
      }
    }
  }'
```

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

---

### 2. 查询任务状态

```bash
curl http://localhost:3000/tasks/task_1772000189593_47731b84
```

**响应：**

```json
{
  "taskId": "task_1772000189593_47731b84",
  "urls": ["https://example.com"],
  "status": "completed",
  "options": { "maxPages": 10 },
  "progress": {
    "completed": 5,
    "total": 1,
    "failed": 0,
    "currentUrl": "https://example.com/page5"
  },
  "result": {
    "files": [
      {
        "type": "html",
        "url": "https://example.com",
        "path": "data/tasks/task_.../c984d06a.html",
        "size": 528,
        "mimeType": "text/html",
        "timestamp": "2026-02-25T06:16:36.358Z"
      }
    ],
    "stats": { "success": 5, "failed": 0, "skipped": 0 },
    "errors": []
  },
  "createdAt": "2026-02-25T06:16:29.596Z",
  "updatedAt": "2026-02-25T06:16:36.431Z",
  "startedAt": "2026-02-25T06:16:29.630Z",
  "completedAt": "2026-02-25T06:16:36.431Z"
}
```

**任务状态值：**

| 状态        | 说明                     |
| ----------- | ------------------------ |
| `pending`   | 已入队，等待 Worker 处理 |
| `running`   | Worker 正在爬取中        |
| `completed` | 爬取完成                 |
| `failed`    | 爬取失败                 |
| `timeout`   | 超时被 Scheduler 标记    |

---

### 3. 查询任务进度

```bash
curl http://localhost:3000/tasks/task_1772000189593_47731b84/progress
```

**响应：**

```json
{
  "taskId": "task_1772000189593_47731b84",
  "status": "running",
  "progress": {
    "completed": 3,
    "total": 1,
    "failed": 0,
    "currentUrl": "https://example.com/page3"
  }
}
```

---

### 4. 列出所有任务

```bash
# 列出所有任务（默认分页 limit=10, offset=0）
curl "http://localhost:3000/tasks"

# 按状态筛选
curl "http://localhost:3000/tasks?status=completed"

# 分页
curl "http://localhost:3000/tasks?limit=20&offset=0"

# 组合查询
curl "http://localhost:3000/tasks?status=running&limit=5&offset=0"
```

**响应：**

```json
{
  "tasks": [
    {
      "taskId": "task_1772000189593_47731b84",
      "urls": ["https://example.com"],
      "status": "completed",
      "progress": { "completed": 1, "total": 1, "failed": 0 },
      "createdAt": "2026-02-25T06:16:29.596Z"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

---

### 5. 更新任务状态

```bash
curl -X PATCH http://localhost:3000/tasks/task_1772000189593_47731b84 \
  -H "Content-Type: application/json" \
  -d '{"status": "failed"}'
```

**响应：**

```json
{
  "taskId": "task_1772000189593_47731b84",
  "status": "failed",
  "updatedAt": "2026-02-25T06:20:00.000Z"
}
```

---

### 6. 删除任务

```bash
curl -X DELETE http://localhost:3000/tasks/task_1772000189593_47731b84
```

**响应：**

```json
{
  "message": "Task task_1772000189593_47731b84 deleted successfully"
}
```

---

### 7. 查询队列统计

```bash
curl http://localhost:3000/queue/stats
```

**响应：**

```json
{
  "waiting": 2,
  "active": 1,
  "completed": 10,
  "failed": 0,
  "delayed": 0
}
```

---

### 8. 健康检查

```bash
# 服务健康检查
curl http://localhost:3000/health

# 就绪检查（含 MongoDB + Redis 连接状态）
curl http://localhost:3000/ready

# Prometheus 指标
curl http://localhost:3000/metrics
```

---

## 爬取结果

每个页面最多生成 4 种文件（取决于 options 配置），保存在 `data/tasks/{taskId}/` 目录下：

```
data/tasks/
└── task_1772000189593_47731b84/
    ├── c984d06aafbecf6bc55569f964148ea3.html    # 原始 HTML
    ├── c984d06aafbecf6bc55569f964148ea3.md      # Markdown 转换（turndown）
    ├── c984d06aafbecf6bc55569f964148ea3.png     # 页面截图（需启用 captureScreenshot）
    ├── c984d06aafbecf6bc55569f964148ea3.pdf     # PDF 导出（需启用 capturePdf）
    └── ...
```

文件名为 URL 的 MD5 哈希值。Markdown 由 [turndown](https://github.com/mixmark-io/turndown) 自动转换，适合直接导入大模型知识库。

**文件类型说明：**

| 类型 | MIME 类型 | 说明 |
| --- | --- | --- |
| `html` | text/html | 原始 HTML |
| `markdown` | text/markdown | HTML 转换的 Markdown |
| `screenshot` | image/png | 全页 PNG 截图（高度超过 16384px 时自动降级为视口截图） |
| `pdf` | application/pdf | A4 尺寸 PDF（含背景色） |

### 文件下载

```bash
# 下载全部文件（ZIP 打包）
curl -OJ http://localhost:3000/tasks/{taskId}/files

# 按类型过滤下载
curl -OJ 'http://localhost:3000/tasks/{taskId}/files?type=html'
curl -OJ 'http://localhost:3000/tasks/{taskId}/files?type=markdown'
curl -OJ 'http://localhost:3000/tasks/{taskId}/files?type=screenshot'
curl -OJ 'http://localhost:3000/tasks/{taskId}/files?type=pdf'

# 单文件下载（过滤后只有 1 个文件时可用）
curl -OJ 'http://localhost:3000/tasks/{taskId}/files?type=screenshot&format=single'
```

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

## 技术栈

- **API 框架**: Fastify
- **爬虫引擎**: Crawlee + Playwright
- **任务队列**: BullMQ + Redis
- **数据库**: MongoDB (Mongoose)
- **日志**: Pino
- **监控**: Prometheus (prom-client)
- **语言**: TypeScript

## License

MIT
