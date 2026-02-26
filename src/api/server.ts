process.env.LOG_FILE = process.env.LOG_FILE || 'api.log';

import Fastify, { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import mongoose from 'mongoose';
import { config } from '../config';
import { createLogger, rootLogger } from '../utils/logger';
import { AppError } from '../errors';
import { metricsRegistry } from '../services/metrics';
import { getQueueService } from '../services/queue';

const logger = createLogger('api');
import { registerTaskRoutes } from './routes';
import { connectDatabase } from '../services/database';

// 创建并配置 Fastify 实例
export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({
    // 复用 rootLogger，确保 Fastify 请求日志的格式和输出通道与应用日志一致
    loggerInstance: rootLogger.child({ name: 'fastify' }) as any,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    trustProxy: process.env.TRUST_PROXY === 'true',
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // 注册 CORS 插件
  const corsOrigins = process.env.CORS_ORIGINS;
  await server.register(cors, {
    origin: corsOrigins ? corsOrigins.split(',').map((o) => o.trim()) : true,
    credentials: true,
  });

  // 健康检查端点
  server.get('/health', async (_request: FastifyRequest, _reply: FastifyReply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // 就绪检查端点（含 Redis 健康检查）
  server.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const dbReady = mongoose.connection.readyState === 1;
    let redisReady = false;
    try {
      redisReady = await getQueueService().ping();
    } catch {
      // Redis not available
    }

    if (!dbReady || !redisReady) {
      reply.status(503).send({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        checks: { database: dbReady, redis: redisReady },
      });
      return;
    }
    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: { database: true, redis: true },
    };
  });

  // 注册任务管理路由
  await registerTaskRoutes(server);

  // Prometheus 指标端点
  server.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Content-Type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // 全局错误处理
  server.setErrorHandler<FastifyError>((error, request, reply) => {
    logger.error({
      err: error,
      reqId: request.id,
      url: request.url,
      method: request.method,
    });

    // 根据错误类型返回不同的状态码
    if (error.validation) {
      reply.status(400).send({
        error: 'Validation Error',
        code: 'VALIDATION_ERROR',
        message: error.message,
        details: error.validation,
      });
      return;
    }

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: error.name,
        code: error.code,
        message: error.message,
      });
      return;
    }

    if (error.statusCode) {
      reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
      });
      return;
    }

    // 默认返回 500
    reply.status(500).send({
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      message: config.env === 'development' ? error.message : 'An error occurred',
    });
  });

  // 404 处理 — 过滤 HTML 特殊字符防止 XSS
  server.setNotFoundHandler((request, reply) => {
    const safeUrl = request.url.replace(/[<>"'&]/g, '');
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${safeUrl} not found`,
    });
  });

  // 优雅关闭处理
  const signals = ['SIGINT', 'SIGTERM'];
  const signalHandlers: Array<() => void> = [];
  signals.forEach((signal) => {
    const handler = async () => {
      logger.info(`Received ${signal}, closing server gracefully...`);
      // Remove signal listeners to avoid accumulation
      signalHandlers.forEach((h, i) => process.removeListener(signals[i], h));
      await server.close();
      process.exit(0);
    };
    signalHandlers.push(handler);
    process.on(signal, handler);
  });

  return server;
}

// 启动服务器
export async function startServer(server: FastifyInstance): Promise<void> {
  try {
    await server.listen({
      port: config.api.port,
      host: '0.0.0.0',
    });
    logger.info(`Server listening on port ${config.api.port}`);
  } catch (error) {
    logger.error(`Failed to start server: ${(error as Error).message}`);
    process.exit(1);
  }
}

// 主入口：如果直接运行此文件，则启动服务器
if (require.main === module) {
  (async () => {
    try {
      // 连接数据库
      await connectDatabase();
      logger.info('Database connected successfully');

      // 创建并启动服务器
      const server = await createServer();
      await startServer(server);
    } catch (error) {
      logger.error(`Failed to start application: ${(error as Error).message}`);
      process.exit(1);
    }
  })();
}
