import mongoose from 'mongoose';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongodb.url, {
      serverSelectionTimeoutMS: 5000,
    });
    logger.info('已连接到 MongoDB');
  } catch (error) {
    logger.error({ error }, '连接 MongoDB 失败');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await mongoose.disconnect();
    logger.info('已断开 MongoDB 连接');
  } catch (error) {
    logger.warn({ error: (error as Error).message }, '断开 MongoDB 连接时出错');
  }
}
