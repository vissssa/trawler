/**
 * 集成测试脚本：启动 API 服务，用真实 MongoDB + Mock Redis 进行 HTTP 请求验证
 *
 * 用法：npx ts-node tests/integration/api-e2e.ts
 */

process.env.LOG_FILE = 'test-api.log';
process.env.NODE_ENV = 'test';

import Fastify from 'fastify';

// ====== Mock Redis / BullMQ 依赖（Redis 不可用）======
// 需要在 import 其他模块之前 mock
const mockJobs = new Map<string, any>();

// Mock queue service module before any import
const mockQueueService = {
  addJob: async (taskId: string, urls: string[], options: any) => {
    const job = { id: taskId, data: { taskId, urls, options } };
    mockJobs.set(taskId, job);
    return job;
  },
  removeJob: async (taskId: string) => {
    mockJobs.delete(taskId);
  },
  getStats: async () => ({
    waiting: mockJobs.size,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  }),
  ping: async () => true,
  getQueue: () => ({}),
  getQueueEvents: () => ({}),
  close: async () => {},
};

// Override the getQueueService module
require.cache[require.resolve('../../src/services/queue')] = {
  id: require.resolve('../../src/services/queue'),
  filename: require.resolve('../../src/services/queue'),
  loaded: true,
  exports: { getQueueService: () => mockQueueService, QueueService: class {} },
} as any;

import { connectDatabase, disconnectDatabase } from '../../src/services/database';
import { createServer } from '../../src/api/server';
import { Task } from '../../src/models/Task';
import type { FastifyInstance } from 'fastify';

// ====== 测试工具 ======
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function inject(server: FastifyInstance, opts: { method: string; url: string; payload?: any }) {
  const res = await server.inject(opts as any);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), headers: res.headers, raw: res };
}

// ====== 测试用例 ======
async function runTests() {
  console.log('\n🔗 连接 MongoDB...');
  await connectDatabase();
  console.log('✅ MongoDB 连接成功\n');

  console.log('🚀 创建 API 服务器...');
  const server = await createServer();
  console.log('✅ 服务器创建成功\n');

  // 清理测试数据
  await Task.deleteMany({ urls: { $in: ['https://test-e2e.example.com'] } });

  let createdTaskId: string | null = null;

  try {
    // ====== 1. 健康检查 ======
    console.log('📋 1. 健康检查端点');
    {
      const { status, body } = await inject(server, { method: 'GET', url: '/health' });
      assert(status === 200, 'GET /health 返回 200');
      assert(body.status === 'ok', '/health status 为 ok');
      assert(typeof body.timestamp === 'string', '/health 包含 timestamp');
      assert(typeof body.uptime === 'number', '/health 包含 uptime');
    }

    // ====== 2. 就绪检查（Redis mock 返回 true） ======
    console.log('\n📋 2. 就绪检查端点');
    {
      const { status, body } = await inject(server, { method: 'GET', url: '/ready' });
      assert(status === 200, 'GET /ready 返回 200');
      assert(body.status === 'ready', '/ready status 为 ready');
      assert(body.checks.database === true, '/ready database = true');
      assert(body.checks.redis === true, '/ready redis = true');
    }

    // ====== 3. Prometheus 指标 ======
    console.log('\n📋 3. Prometheus 指标端点');
    {
      const res = await server.inject({ method: 'GET', url: '/metrics' });
      assert(res.statusCode === 200, 'GET /metrics 返回 200');
      assert(res.headers['content-type']?.toString().includes('text') === true, '/metrics Content-Type 为 text');
      assert(res.body.length > 0, '/metrics 返回非空内容');
    }

    // ====== 4. 404 处理 ======
    console.log('\n📋 4. 404 路由处理');
    {
      const { status, body } = await inject(server, { method: 'GET', url: '/nonexistent' });
      assert(status === 404, 'GET /nonexistent 返回 404');
      assert(body.error === 'Not Found', '错误类型为 Not Found');
      assert(body.message.includes('/nonexistent'), 'message 包含路径');
    }

    // ====== 5. XSS 防护 ======
    console.log('\n📋 5. 404 XSS 防护');
    {
      const { status, body } = await inject(server, { method: 'GET', url: '/test<script>alert(1)</script>' });
      assert(status === 404, 'XSS URL 返回 404');
      assert(!body.message.includes('<script>'), 'message 中不含 <script> 标签（XSS 防护）');
    }

    // ====== 6. 创建任务 — 正常 ======
    console.log('\n📋 6. 创建任务');
    {
      const { status, body } = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: ['https://test-e2e.example.com'],
          options: { maxDepth: 2 },
        },
      });
      assert(status === 201, 'POST /tasks 返回 201');
      assert(typeof body.taskId === 'string' && body.taskId.startsWith('task_'), 'taskId 格式正确');
      assert(body.status === 'pending', 'status 为 pending');
      assert(Array.isArray(body.urls), '返回 urls 数组');
      assert(typeof body.createdAt === 'string', '返回 createdAt');
      createdTaskId = body.taskId;
      console.log(`    创建的 taskId: ${createdTaskId}`);
    }

    // ====== 7. 创建任务 — URL 去重 ======
    console.log('\n📋 7. 创建任务 URL 去重');
    {
      const { status, body } = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: [
            'https://test-e2e.example.com',
            'https://test-e2e.example.com',
            'https://test-e2e.example.com',
          ],
        },
      });
      assert(status === 201, 'POST /tasks 去重后返回 201');
      assert(body.urls.length === 1, '去重后 urls 只有 1 个');
      // 清理这个额外的任务
      if (body.taskId) {
        await Task.deleteOne({ taskId: body.taskId });
      }
    }

    // ====== 8. 创建任务 — 参数校验 ======
    console.log('\n📋 8. 参数校验');
    {
      // 空 urls
      const res1 = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: { urls: [] },
      });
      assert(res1.status === 400, 'urls=[] 返回 400');

      // 无效 URL
      const res2 = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: { urls: ['not-a-url'] },
      });
      assert(res2.status === 400, '无效 URL 返回 400');

      // 缺少 urls 字段
      const res3 = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: {},
      });
      assert(res3.status === 400, '缺少 urls 返回 400');
    }

    // ====== 9. taskId 路径穿越防护 ======
    console.log('\n📋 9. taskId 路径穿越防护');
    {
      const res1 = await inject(server, { method: 'GET', url: '/tasks/../../../etc/passwd' });
      assert(res1.status === 400 || res1.status === 404, '路径穿越 taskId 被拦截');

      const res2 = await inject(server, { method: 'GET', url: '/tasks/evil%2F..%2F..%2Fetc' });
      assert(res2.status === 400 || res2.status === 404, 'URL 编码路径穿越被拦截');
    }

    // ====== 10. 获取任务详情 ======
    console.log('\n📋 10. 获取任务详情');
    if (createdTaskId) {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${createdTaskId}`,
      });
      assert(status === 200, `GET /tasks/${createdTaskId} 返回 200`);
      assert(body.taskId === createdTaskId, 'taskId 匹配');
      assert(body.status === 'pending', 'status 为 pending');
      assert(body.options?.maxDepth === 2, 'options.maxDepth 为 2');
      assert(body.progress?.total === 1, 'progress.total 为 1');
      assert(typeof body.createdAt === 'string', '包含 createdAt');
      assert(typeof body.updatedAt === 'string', '包含 updatedAt');
    }

    // ====== 11. 获取不存在的任务 ======
    console.log('\n📋 11. 获取不存在的任务');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: '/tasks/task_nonexistent_xyz',
      });
      assert(status === 404, '不存在的任务返回 404');
      assert(body.code === 'TASK_NOT_FOUND', 'code 为 TASK_NOT_FOUND');
    }

    // ====== 12. 列出任务 ======
    console.log('\n📋 12. 列出任务');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: '/tasks?limit=5&offset=0',
      });
      assert(status === 200, 'GET /tasks 返回 200');
      assert(Array.isArray(body.tasks), 'tasks 是数组');
      assert(typeof body.total === 'number', '包含 total');
      assert(body.limit === 5, 'limit 为 5');
      assert(body.offset === 0, 'offset 为 0');
    }

    // ====== 13. 按状态过滤任务 ======
    console.log('\n📋 13. 按状态过滤任务');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: '/tasks?status=pending',
      });
      assert(status === 200, 'GET /tasks?status=pending 返回 200');
      assert(body.tasks.every((t: any) => t.status === 'pending'), '所有任务 status 为 pending');
    }

    // ====== 14. 获取任务进度 ======
    console.log('\n📋 14. 获取任务进度');
    if (createdTaskId) {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${createdTaskId}/progress`,
      });
      assert(status === 200, `GET /tasks/${createdTaskId}/progress 返回 200`);
      assert(body.taskId === createdTaskId, 'taskId 匹配');
      assert(body.status === 'pending', 'status 为 pending');
      assert(typeof body.progress === 'object', 'progress 是对象');
      assert(body.progress.completed === 0, 'progress.completed 为 0');
      assert(body.progress.total === 1, 'progress.total 为 1');
    }

    // ====== 15. 获取队列统计 ======
    console.log('\n📋 15. 获取队列统计');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: '/queue/stats',
      });
      assert(status === 200, 'GET /queue/stats 返回 200');
      assert(typeof body.waiting === 'number', '包含 waiting');
      assert(typeof body.active === 'number', '包含 active');
      assert(typeof body.completed === 'number', '包含 completed');
      assert(typeof body.failed === 'number', '包含 failed');
      assert(typeof body.delayed === 'number', '包含 delayed');
    }

    // ====== 16. PATCH 取消任务（PENDING → FAILED） ======
    console.log('\n📋 16. PATCH 取消任务');
    if (createdTaskId) {
      const { status, body } = await inject(server, {
        method: 'PATCH',
        url: `/tasks/${createdTaskId}`,
        payload: { status: 'failed' },
      });
      assert(status === 200, `PATCH /tasks/${createdTaskId} 返回 200`);
      assert(body.status === 'failed', '状态变更为 failed');
      assert(typeof body.updatedAt === 'string', '包含 updatedAt');

      // 验证 DB 中的 errorMessage 和 completedAt
      const dbTask = await Task.findOne({ taskId: createdTaskId });
      assert(dbTask?.errorMessage === 'Cancelled by user', 'DB errorMessage 为 Cancelled by user');
      assert(dbTask?.completedAt instanceof Date, 'DB completedAt 已设置');
    }

    // ====== 17. PATCH 非法状态转换 ======
    console.log('\n📋 17. 非法状态转换');
    if (createdTaskId) {
      // 已经是 FAILED 的任务不能再变回 PENDING
      const { status, body } = await inject(server, {
        method: 'PATCH',
        url: `/tasks/${createdTaskId}`,
        payload: { status: 'pending' },
      });
      assert(status === 400, '非法状态转换返回 400');
      assert(body.code === 'INVALID_STATE_TRANSITION', 'code 为 INVALID_STATE_TRANSITION');
      assert(body.message.includes('Cannot transition'), 'message 包含 Cannot transition');
    }

    // ====== 18. 文件下载 — 无文件 ======
    console.log('\n📋 18. 文件下载 — 无文件');
    if (createdTaskId) {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${createdTaskId}/files`,
      });
      assert(status === 404, '无文件返回 404');
      assert(body.message?.includes('No files'), 'message 包含 No files');
    }

    // ====== 19. CORS 检查 ======
    console.log('\n📋 19. CORS 响应头');
    {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://test-origin.com',
          'access-control-request-method': 'GET',
        },
      });
      assert(res.headers['access-control-allow-origin'] !== undefined, '包含 access-control-allow-origin');
    }

    // ====== 20. Schema 验证 — additionalProperties ======
    console.log('\n📋 20. Schema 额外属性校验');
    {
      const { status } = await inject(server, {
        method: 'POST',
        url: '/tasks',
        payload: {
          urls: ['https://test-e2e.example.com'],
          options: { maxDepth: 2, hackerField: true },
        },
      });
      assert(status === 400, 'options 中不允许额外属性，返回 400');
    }

    // ====== 21. 删除任务 ======
    console.log('\n📋 21. 删除任务');
    if (createdTaskId) {
      const { status, body } = await inject(server, {
        method: 'DELETE',
        url: `/tasks/${createdTaskId}`,
      });
      assert(status === 200, `DELETE /tasks/${createdTaskId} 返回 200`);
      assert(body.message.includes('deleted successfully'), 'message 包含 deleted successfully');

      // 确认已删除
      const { status: checkStatus } = await inject(server, {
        method: 'GET',
        url: `/tasks/${createdTaskId}`,
      });
      assert(checkStatus === 404, '删除后查询返回 404');
    }

    // ====== 22. 删除不存在的任务 ======
    console.log('\n📋 22. 删除不存在的任务');
    {
      const { status } = await inject(server, {
        method: 'DELETE',
        url: '/tasks/task_does_not_exist',
      });
      assert(status === 404, '删除不存在的任务返回 404');
    }

  } finally {
    // 清理
    console.log('\n🧹 清理...');
    if (createdTaskId) {
      await Task.deleteMany({ taskId: createdTaskId }).catch(() => {});
    }
    await Task.deleteMany({ urls: { $in: ['https://test-e2e.example.com'] } }).catch(() => {});
    await server.close();
    await disconnectDatabase();
  }

  // 结果汇总
  console.log('\n' + '='.repeat(60));
  console.log(`📊 测试结果：${passed} 通过, ${failed} 失败 / 共 ${passed + failed} 个断言`);
  if (failures.length > 0) {
    console.log('\n❌ 失败列表：');
    failures.forEach((f) => console.log(`   • ${f}`));
  }
  console.log('='.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('❌ 测试执行失败:', err);
  process.exit(1);
});
