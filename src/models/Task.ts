import mongoose, { Schema, Document } from 'mongoose';
import { randomBytes } from 'crypto';

// 任务状态枚举
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
}

// 认证配置接口
export interface AuthConfig {
  type: 'basic' | 'bearer' | 'cookie';
  credentials: {
    username?: string;
    password?: string;
    token?: string;
    cookies?: Record<string, string>;
  };
}

// 爬虫选项接口
export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  timeout?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  auth?: AuthConfig;
  followRedirects?: boolean;
  captureScreenshot?: boolean;
  extractResources?: boolean;
  respectRobotsTxt?: boolean;
  rateLimit?: {
    maxRequests: number;
    perSeconds: number;
  };
}

// 文件结果接口
export interface FileResult {
  type: 'html' | 'pdf' | 'screenshot' | 'resource';
  url: string;
  path: string;
  size: number;
  mimeType?: string;
  timestamp: Date;
  error?: string;
}

// 任务进度接口
export interface TaskProgress {
  completed: number;
  total: number;
  failed: number;
  currentUrl?: string;
}

// 任务结果接口
export interface TaskResult {
  files: FileResult[];
  stats: {
    success: number;
    failed: number;
    skipped: number;
  };
  errors?: Array<{
    url: string;
    error: string;
    timestamp: Date;
  }>;
}

// 任务文档接口
export interface TaskDocument extends Document {
  taskId: string;
  urls: string[];
  status: TaskStatus;
  options: CrawlOptions;
  progress: TaskProgress;
  result: TaskResult;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Task Schema
const taskSchema = new Schema<TaskDocument>(
  {
    taskId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: generateTaskId,
    },
    urls: {
      type: [String],
      required: true,
      validate: {
        validator: function (urls: string[]) {
          return urls.length > 0;
        },
        message: 'At least one URL is required',
      },
    },
    status: {
      type: String,
      enum: Object.values(TaskStatus),
      default: TaskStatus.PENDING,
      index: true,
    },
    options: {
      type: Schema.Types.Mixed,
      default: {},
    },
    progress: {
      completed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      currentUrl: { type: String },
    },
    result: {
      files: {
        type: [
          {
            type: { type: String, enum: ['html', 'pdf', 'screenshot', 'resource'] },
            url: String,
            path: String,
            size: Number,
            mimeType: String,
            timestamp: Date,
            error: String,
          },
        ],
        default: [],
      },
      stats: {
        success: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
      },
      errors: {
        type: [
          {
            url: String,
            error: String,
            timestamp: Date,
          },
        ],
        default: [],
      },
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
    errorMessage: { type: String },
  },
  {
    timestamps: true,
  }
);

// 生成唯一的 taskId
function generateTaskId(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  return `task_${timestamp}_${random}`;
}

// 索引配置
taskSchema.index({ createdAt: 1 });
taskSchema.index({ status: 1, createdAt: -1 });

// 导出模型
export const Task = mongoose.model<TaskDocument>('Task', taskSchema);
