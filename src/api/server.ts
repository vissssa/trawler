process.env.LOG_FILE = process.env.LOG_FILE || 'api.log';

import Fastify, { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('api');
import { registerTaskRoutes } from './routes';
import { connectDatabase } from '../services/database';

// 创建并配置 Fastify 实例
export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.env === 'production' ? 'info' : 'debug',
      transport:
        config.env === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    trustProxy: true,
  });

  // 注册 CORS 插件
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // 注册 multipart 插件（用于文件上传）
  await server.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1000000,
      fields: 10,
      fileSize: 10000000, // 10MB
      files: 1,
      headerPairs: 2000,
    },
  });

  // 健康检查端点
  server.get('/health', async (_request: FastifyRequest, _reply: FastifyReply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // 就绪检查端点
  server.get('/ready', async (_request: FastifyRequest, _reply: FastifyReply) => {
    // TODO: 添加数据库连接检查等
    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
    };
  });

  // 注册任务管理路由
  await registerTaskRoutes(server);

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
        message: error.message,
        details: error.validation,
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
      message: config.env === 'development' ? error.message : 'An error occurred',
    });
  });

  // 404 处理
  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  // 优雅关闭处理
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, closing server gracefully...`);
      await server.close();
      process.exit(0);
    });
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
