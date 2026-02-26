/**
 * 端到端爬虫流程测试：
 * 1. 启动 API + Worker
 * 2. 创建爬取任务
 * 3. 等待 Worker 完成
 * 4. 检查进度/结果
 * 5. 下载文件
 * 6. 删除任务
 */

process.env.LOG_FILE = 'test-e2e-crawl.log';
process.env.NODE_ENV = 'test';

import { connectDatabase, disconnectDatabase } from '../../src/services/database';
import { createServer } from '../../src/api/server';
import { Task, TaskStatus } from '../../src/models/Task';
import { processJob } from '../../src/worker/consumer';
import type { FastifyInstance } from 'fastify';
import { Job } from 'bullmq';

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
  let body: any = {};
  try { body = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body, headers: res.headers, raw: res };
}

async function waitForTaskStatus(taskId: string, targetStatuses: string[], timeoutMs = 60000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await Task.findOne({ taskId });
    if (task && targetStatuses.includes(task.status)) {
      return task;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for task ${taskId} to reach ${targetStatuses.join('|')}`);
}

async function runE2E() {
  console.log('\n🔗 连接 MongoDB...');
  await connectDatabase();
  console.log('✅ MongoDB 连接成功\n');

  console.log('🚀 创建 API 服务器...');
  const server = await createServer();
  console.log('✅ 服务器创建成功\n');

  let taskId: string | null = null;

  try {
    // ====== Step 1: 创建爬取任务 ======
    console.log('📋 Step 1: 创建爬取任务');
    const targetUrl = 'https://example.com';
    const { status: createStatus, body: createBody } = await inject(server, {
      method: 'POST',
      url: '/tasks',
      payload: {
        urls: [targetUrl],
        options: {
          maxDepth: 1,
          maxPages: 2,
          captureScreenshot: true,
          capturePdf: true,
        },
      },
    });
    assert(createStatus === 201, '创建任务返回 201');
    taskId = createBody.taskId;
    assert(!!taskId, `taskId 存在: ${taskId}`);
    console.log(`    taskId: ${taskId}\n`);

    // ====== Step 2: 确认任务状态为 PENDING ======
    console.log('📋 Step 2: 确认初始状态');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${taskId}`,
      });
      assert(status === 200, '查询任务返回 200');
      assert(body.status === 'pending', '初始状态为 pending');
      assert(body.progress?.total === 1, 'progress.total 为 1');
    }

    // ====== Step 3: 模拟 Worker 处理 ======
    console.log('\n📋 Step 3: 执行 Worker 爬取（直接调用 processJob）');
    const mockJob = {
      data: {
        taskId: taskId!,
        urls: [targetUrl],
        options: { maxDepth: 1, maxPages: 2, captureScreenshot: true, capturePdf: true },
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<any>;

    try {
      await processJob(mockJob);
      assert(true, 'processJob 执行完成');
    } catch (err: any) {
      assert(false, 'processJob 执行完成', err.message);
    }

    // ====== Step 4: 检查完成状态 ======
    console.log('\n📋 Step 4: 检查任务完成状态');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${taskId}`,
      });
      assert(status === 200, '查询任务返回 200');
      assert(
        body.status === 'completed' || body.status === 'failed',
        `任务状态为终态: ${body.status}`
      );
      assert(typeof body.completedAt === 'string', 'completedAt 已设置');

      if (body.status === 'completed') {
        assert(body.progress?.completed >= 1, `completed >= 1 (actual: ${body.progress?.completed})`);
        console.log(`    progress: completed=${body.progress.completed}, failed=${body.progress.failed}, total=${body.progress.total}`);
      }
    }

    // ====== Step 5: 检查进度端点 ======
    console.log('\n📋 Step 5: 检查进度端点');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${taskId}/progress`,
      });
      assert(status === 200, '进度查询返回 200');
      assert(typeof body.progress === 'object', 'progress 是对象');
      console.log(`    status: ${body.status}, progress: completed=${body.progress.completed}, failed=${body.progress.failed}`);
    }

    // ====== Step 6: 检查任务结果中的文件 ======
    console.log('\n📋 Step 6: 检查结果文件');
    {
      const task = await Task.findOne({ taskId });
      const files = task?.result?.files || [];
      assert(files.length > 0, `结果中包含文件 (count: ${files.length})`);

      if (files.length > 0) {
        const htmlFiles = files.filter((f: any) => f.type === 'html');
        const mdFiles = files.filter((f: any) => f.type === 'markdown');
        const screenshotFiles = files.filter((f: any) => f.type === 'screenshot');
        const pdfFiles = files.filter((f: any) => f.type === 'pdf');
        assert(htmlFiles.length > 0, `包含 HTML 文件 (count: ${htmlFiles.length})`);
        assert(mdFiles.length > 0, `包含 Markdown 文件 (count: ${mdFiles.length})`);
        assert(screenshotFiles.length > 0, `包含截图文件 (count: ${screenshotFiles.length})`);
        assert(pdfFiles.length > 0, `包含 PDF 文件 (count: ${pdfFiles.length})`);

        // 打印所有文件详情
        console.log('    文件列表:');
        for (const f of files) {
          console.log(`      - [${f.type}] ${f.path} (${f.size} bytes, ${f.mimeType})`);
        }

        // 检查截图文件属性
        if (screenshotFiles.length > 0) {
          const ss = screenshotFiles[0];
          assert(ss.mimeType === 'image/png', `截图 mimeType 为 image/png`);
          assert(ss.size > 0, `截图 size > 0: ${ss.size}`);
          assert(ss.path.endsWith('.png'), '截图文件名以 .png 结尾');
        }

        // 检查 PDF 文件属性
        if (pdfFiles.length > 0) {
          const pdf = pdfFiles[0];
          assert(pdf.mimeType === 'application/pdf', `PDF mimeType 为 application/pdf`);
          assert(pdf.size > 0, `PDF size > 0: ${pdf.size}`);
          assert(pdf.path.endsWith('.pdf'), 'PDF 文件名以 .pdf 结尾');
        }

        // 检查通用文件属性
        const firstFile = files[0];
        assert(typeof firstFile.url === 'string', '文件有 url');
        assert(typeof firstFile.path === 'string', '文件有 path');
        assert(typeof firstFile.size === 'number' && firstFile.size > 0, `文件有 size: ${firstFile.size}`);
        assert(typeof firstFile.mimeType === 'string', '文件有 mimeType');
      }
    }

    // ====== Step 7: 通过 API 获取详情 — 验证 path 脱敏 ======
    console.log('\n📋 Step 7: 验证 API 返回的 path 已脱敏');
    {
      const { status, body } = await inject(server, {
        method: 'GET',
        url: `/tasks/${taskId}`,
      });
      assert(status === 200, '获取详情返回 200');
      const apiFiles = body.result?.files || [];
      if (apiFiles.length > 0) {
        const firstPath = apiFiles[0].path;
        assert(!firstPath.includes('/'), `API path 不含 /: "${firstPath}"`);
        assert(!firstPath.includes('\\'), `API path 不含 \\: "${firstPath}"`);
      }
    }

    // ====== Step 8: 验证磁盘文件实际存在 ======
    console.log('\n📋 Step 8: 验证磁盘文件实际存在');
    {
      const { existsSync } = require('fs');
      const task = await Task.findOne({ taskId });
      const files = task?.result?.files || [];
      for (const f of files) {
        const exists = existsSync(f.path);
        assert(exists, `磁盘文件存在: [${f.type}] ${f.path}`);
      }
    }

    // ====== Step 9: 尝试文件下载 ======
    console.log('\n📋 Step 9: 文件下载端点');
    {
      const task = await Task.findOne({ taskId });
      const hasFiles = (task?.result?.files || []).length > 0;
      if (hasFiles) {
        const res = await server.inject({
          method: 'GET',
          url: `/tasks/${taskId}/files`,
        } as any);
        // ZIP 下载通过 reply.raw 直接写 stream，server.inject() 可能返回 200 或者空
        // 主要验证不报错
        assert(res.statusCode === 200 || res.statusCode < 500, `文件下载不报 500 (status: ${res.statusCode})`);
      } else {
        console.log('    ⏭️  跳过：无文件可下载');
      }
    }

    // ====== Step 10: 删除任务 ======
    console.log('\n📋 Step 10: 删除任务');
    {
      const { status, body } = await inject(server, {
        method: 'DELETE',
        url: `/tasks/${taskId}`,
      });
      assert(status === 200, '删除任务返回 200');
      assert(body.message.includes('deleted successfully'), 'message 正确');

      // 确认已清理
      const dbTask = await Task.findOne({ taskId });
      assert(dbTask === null, 'DB 中任务已删除');
    }
    taskId = null; // 已删除，不需要清理

  } finally {
    // 清理
    console.log('\n🧹 清理...');
    if (taskId) {
      await Task.deleteOne({ taskId }).catch(() => {});
    }
    await server.close();
    await disconnectDatabase();
  }

  // 结果汇总
  console.log('\n' + '='.repeat(60));
  console.log(`📊 端到端测试结果：${passed} 通过, ${failed} 失败 / 共 ${passed + failed} 个断言`);
  if (failures.length > 0) {
    console.log('\n❌ 失败列表：');
    failures.forEach((f) => console.log(`   • ${f}`));
  }
  console.log('='.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runE2E().catch((err) => {
  console.error('❌ E2E 测试失败:', err);
  process.exit(1);
});
