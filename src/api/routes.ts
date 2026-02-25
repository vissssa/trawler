import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream, existsSync } from 'fs';
import { stat, rm } from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import { Task, TaskStatus, CrawlOptions } from '../models/Task';
import { getQueueService } from '../services/queue';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('api:routes');

// 请求类型定义
interface CreateTaskBody {
  urls: string[];
  options?: CrawlOptions;
}

interface TaskIdParams {
  taskId: string;
}

interface UpdateTaskBody {
  status?: TaskStatus;
}

// 注册任务管理路由
export async function registerTaskRoutes(server: FastifyInstance): Promise<void> {
  const queueService = getQueueService();

  // POST /tasks - 创建新任务
  server.post<{ Body: CreateTaskBody }>(
    '/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['urls'],
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
              minItems: 1,
            },
            options: {
              type: 'object',
              properties: {
                maxDepth: { type: 'number', minimum: 1 },
                maxPages: { type: 'number', minimum: 1 },
                timeout: { type: 'number', minimum: 1000 },
                userAgent: { type: 'string' },
                headers: { type: 'object' },
                followRedirects: { type: 'boolean' },
                captureScreenshot: { type: 'boolean' },
                extractResources: { type: 'boolean' },
                respectRobotsTxt: { type: 'boolean' },
                contentSelector: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                  ],
                },
              },
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              status: { type: 'string' },
              urls: { type: 'array', items: { type: 'string' } },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateTaskBody }>, reply: FastifyReply) => {
      const { urls, options = {} } = request.body;
      const uniqueUrls = [...new Set(urls)];

      try {
        // 创建任务文档
        const task = new Task({
          urls: uniqueUrls,
          options,
          status: TaskStatus.PENDING,
          progress: {
            completed: 0,
            total: uniqueUrls.length,
            failed: 0,
          },
        });

        await task.save();
        logger.info(`Created task ${task.taskId}`);

        // 添加到队列
        await queueService.addJob(task.taskId, uniqueUrls, options);
        logger.info(`Added task ${task.taskId} to queue`);

        reply.status(201).send({
          taskId: task.taskId,
          status: task.status,
          urls: task.urls,
          createdAt: task.createdAt.toISOString(),
        });
      } catch (error) {
        logger.error(`Failed to create task: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // GET /tasks/:taskId - 获取任务详情
  server.get<{ Params: TaskIdParams }>(
    '/tasks/:taskId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
          },
          required: ['taskId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              urls: { type: 'array', items: { type: 'string' } },
              status: { type: 'string' },
              options: { type: 'object' },
              progress: { type: 'object' },
              result: { type: 'object' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
              startedAt: { type: 'string', nullable: true },
              completedAt: { type: 'string', nullable: true },
              errorMessage: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: TaskIdParams }>, reply: FastifyReply) => {
      const { taskId } = request.params;

      try {
        const task = await Task.findOne({ taskId });

        if (!task) {
          reply.status(404).send({
            error: 'Not Found',
            message: `Task ${taskId} not found`,
          });
          return;
        }

        reply.send({
          taskId: task.taskId,
          urls: task.urls,
          status: task.status,
          options: task.options,
          progress: task.progress,
          result: task.result,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          startedAt: task.startedAt?.toISOString(),
          completedAt: task.completedAt?.toISOString(),
          errorMessage: task.errorMessage,
        });
      } catch (error) {
        logger.error(`Failed to get task ${taskId}: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // GET /tasks - 列出所有任务
  server.get<{
    Querystring: {
      status?: TaskStatus;
      limit?: string;
      offset?: string;
    };
  }>(
    '/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: Object.values(TaskStatus) },
            limit: { type: 'string', pattern: '^[0-9]+$' },
            offset: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    taskId: { type: 'string' },
                    urls: { type: 'array', items: { type: 'string' } },
                    status: { type: 'string' },
                    progress: { type: 'object' },
                    createdAt: { type: 'string' },
                  },
                },
              },
              total: { type: 'number' },
              limit: { type: 'number' },
              offset: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { status, limit = '10', offset = '0' } = request.query;
      const limitNum = Math.min(parseInt(limit, 10) || 10, 100);
      const offsetNum = parseInt(offset, 10) || 0;

      try {
        const query = status ? { status } : {};
        const [tasks, total] = await Promise.all([
          Task.find(query).sort({ createdAt: -1 }).limit(limitNum).skip(offsetNum),
          Task.countDocuments(query),
        ]);

        reply.send({
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            urls: task.urls,
            status: task.status,
            progress: task.progress,
            createdAt: task.createdAt.toISOString(),
          })),
          total,
          limit: limitNum,
          offset: offsetNum,
        });
      } catch (error) {
        logger.error(`Failed to list tasks: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // PATCH /tasks/:taskId - 更新任务
  server.patch<{
    Params: TaskIdParams;
    Body: UpdateTaskBody;
  }>(
    '/tasks/:taskId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
          },
          required: ['taskId'],
        },
        body: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: Object.values(TaskStatus) },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              status: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: TaskIdParams; Body: UpdateTaskBody }>,
      reply: FastifyReply
    ) => {
      const { taskId } = request.params;
      const { status } = request.body;

      try {
        const task = await Task.findOne({ taskId });

        if (!task) {
          reply.status(404).send({
            error: 'Not Found',
            message: `Task ${taskId} not found`,
          });
          return;
        }

        if (status) {
          // Validate state transitions — only allow cancelling pending/running tasks
          const allowedTransitions: Record<string, string[]> = {
            [TaskStatus.PENDING]: [TaskStatus.FAILED],
            [TaskStatus.RUNNING]: [TaskStatus.FAILED],
          };
          const allowed = allowedTransitions[task.status];
          if (!allowed || !allowed.includes(status)) {
            reply.status(400).send({
              error: 'Bad Request',
              message: `Cannot transition from '${task.status}' to '${status}'`,
            });
            return;
          }
          task.status = status;
        }

        await task.save();
        logger.info(`Updated task ${taskId}`);

        reply.send({
          taskId: task.taskId,
          status: task.status,
          updatedAt: task.updatedAt.toISOString(),
        });
      } catch (error) {
        logger.error(`Failed to update task ${taskId}: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // DELETE /tasks/:taskId - 删除任务
  server.delete<{ Params: TaskIdParams }>(
    '/tasks/:taskId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
          },
          required: ['taskId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: TaskIdParams }>, reply: FastifyReply) => {
      const { taskId } = request.params;

      try {
        const task = await Task.findOne({ taskId });

        if (!task) {
          reply.status(404).send({
            error: 'Not Found',
            message: `Task ${taskId} not found`,
          });
          return;
        }

        // 从队列中移除
        await queueService.removeJob(taskId);

        // 删除磁盘上的爬取文件
        const taskDir = path.join(config.storage.dataDir, taskId);
        try {
          await rm(taskDir, { recursive: true, force: true });
        } catch {
          // ignore if directory doesn't exist
        }

        // 删除任务文档
        await Task.deleteOne({ taskId });
        logger.info(`Deleted task ${taskId}`);

        reply.send({
          message: `Task ${taskId} deleted successfully`,
        });
      } catch (error) {
        logger.error(`Failed to delete task ${taskId}: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // GET /tasks/:taskId/progress - 获取任务进度
  server.get<{ Params: TaskIdParams }>(
    '/tasks/:taskId/progress',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
          },
          required: ['taskId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              status: { type: 'string' },
              progress: {
                type: 'object',
                properties: {
                  completed: { type: 'number' },
                  total: { type: 'number' },
                  failed: { type: 'number' },
                  currentUrl: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: TaskIdParams }>, reply: FastifyReply) => {
      const { taskId } = request.params;

      try {
        const task = await Task.findOne({ taskId }, 'taskId status progress');

        if (!task) {
          reply.status(404).send({
            error: 'Not Found',
            message: `Task ${taskId} not found`,
          });
          return;
        }

        reply.send({
          taskId: task.taskId,
          status: task.status,
          progress: task.progress,
        });
      } catch (error) {
        logger.error(`Failed to get task progress ${taskId}: ${(error as Error).message}`);
        throw error;
      }
    }
  );

  // GET /queue/stats - 获取队列统计信息
  server.get('/queue/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await queueService.getStats();
      reply.send(stats);
    } catch (error) {
      logger.error(`Failed to get queue stats: ${(error as Error).message}`);
      throw error;
    }
  });

  // GET /tasks/:taskId/files - 下载任务文件
  server.get<{
    Params: TaskIdParams;
    Querystring: { type?: string; format?: string };
  }>(
    '/tasks/:taskId/files',
    {
      schema: {
        params: {
          type: 'object',
          properties: { taskId: { type: 'string' } },
          required: ['taskId'],
        },
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['html', 'markdown', 'all'], default: 'all' },
            format: { type: 'string', enum: ['zip', 'single'], default: 'zip' },
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params;
      const { type = 'all', format = 'zip' } = request.query;

      try {
        const task = await Task.findOne({ taskId }, 'taskId status result');
        if (!task) {
          reply.status(404).send({ error: 'Not Found', message: `Task ${taskId} not found` });
          return;
        }

        // Filter files by type
        let files = task.result?.files || [];
        if (type !== 'all') {
          files = files.filter((f) => f.type === type);
        }

        if (files.length === 0) {
          reply
            .status(404)
            .send({ error: 'Not Found', message: 'No files available for this task' });
          return;
        }

        // Single file download
        if (format === 'single' && files.length === 1) {
          const file = files[0];
          if (!existsSync(file.path)) {
            reply.status(404).send({ error: 'Not Found', message: 'File not found on disk' });
            return;
          }
          const fileStat = await stat(file.path);
          const fileName = path.basename(file.path).replace(/"/g, '\\"');
          reply
            .header('Content-Type', file.mimeType || 'application/octet-stream')
            .header('Content-Disposition', `attachment; filename="${fileName}"`)
            .header('Content-Length', fileStat.size);
          return reply.send(createReadStream(file.path));
        }

        // Zip download — collect into buffer and send via Fastify reply
        const archive = archiver('zip', { zlib: { level: 6 } });

        const chunks: Buffer[] = [];
        archive.on('data', (chunk: Buffer) => chunks.push(chunk));

        const archiveFinished = new Promise<Buffer>((resolve, reject) => {
          archive.on('end', () => resolve(Buffer.concat(chunks)));
          archive.on('error', reject);
        });

        for (const file of files) {
          if (existsSync(file.path)) {
            archive.file(file.path, { name: path.basename(file.path) });
          }
        }

        await archive.finalize();
        const zipBuffer = await archiveFinished;

        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${taskId}.zip"`)
          .header('Content-Length', zipBuffer.length)
          .send(zipBuffer);
      } catch (error) {
        logger.error(`Failed to download files for ${taskId}: ${(error as Error).message}`);
        throw error;
      }
    }
  );
}
