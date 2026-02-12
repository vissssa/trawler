import pino from 'pino';

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

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
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: process.env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
  });
}

export const logger = createLogger('trawler');
