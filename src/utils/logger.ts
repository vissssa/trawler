import pino from 'pino';
import { mkdirSync } from 'fs';
import path from 'path';

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const LOG_DIR = process.env.LOG_DIR || './logs';

// 确保日志目录存在
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

// 进程级日志文件，由入口点通过 LOG_FILE 环境变量设置
// api → api.log, worker → worker.log, scheduler → scheduler.log
const logFile = path.join(LOG_DIR, process.env.LOG_FILE || 'app.log');

export function createLogger(name: string) {
  let logLevel = process.env.LOG_LEVEL || 'info';

  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    console.warn(
      `Invalid LOG_LEVEL "${logLevel}", falling back to "info". ` +
      `Valid levels: ${VALID_LOG_LEVELS.join(', ')}`
    );
    logLevel = 'info';
  }

  return pino({
    name,
    level: logLevel,
    transport: {
      targets: [
        // 控制台输出
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
              level: logLevel,
            }
          : {
              target: 'pino/file',
              options: { destination: 1 }, // stdout
              level: logLevel,
            },
        // 文件输出（同一进程所有模块写入同一文件）
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: false,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                singleLine: true,
                destination: logFile,
                mkdir: true,
              },
              level: logLevel,
            }
          : {
              target: 'pino/file',
              options: { destination: logFile, mkdir: true },
              level: logLevel,
            },
      ],
    },
  });
}

export const logger = createLogger('trawler');
