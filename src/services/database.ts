import mongoose from 'mongoose';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongodb.url);
    logger.info('已连接到 MongoDB');
  } catch (error) {
    logger.error({ error }, '连接 MongoDB 失败');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('已断开 MongoDB 连接');
}
