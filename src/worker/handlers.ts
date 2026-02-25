import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { Task } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('worker:handlers');

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

export function createRequestHandler(taskId: string) {
  return async (ctx: PlaywrightCrawlingContext) => {
    const { page, request, enqueueLinks } = ctx;
    const url = request.url;

    logger.info({ taskId, url }, 'Processing page');

    // Update current URL in progress
    await Task.updateOne({ taskId }, { $set: { 'progress.currentUrl': url } });

    // Get page HTML
    const html = await page.content();

    // Save HTML file
    const taskDir = path.join(config.storage.dataDir, taskId);
    await mkdir(taskDir, { recursive: true });

    const fileName = `${md5(url)}.html`;
    const filePath = path.join(taskDir, fileName);
    await writeFile(filePath, html, 'utf-8');

    const fileSize = Buffer.byteLength(html, 'utf-8');

    // Atomic update: increment progress and push file result
    await Task.updateOne(
      { taskId },
      {
        $inc: { 'progress.completed': 1, 'result.stats.success': 1 },
        $push: {
          'result.files': {
            type: 'html',
            url,
            path: filePath,
            size: fileSize,
            mimeType: 'text/html',
            timestamp: new Date(),
          },
        },
      }
    );

    logger.info({ taskId, url, filePath, fileSize }, 'Page saved');

    // Enqueue discovered links (same-domain only)
    await enqueueLinks({ strategy: 'same-domain' });
  };
}

export function createFailedRequestHandler(taskId: string) {
  return async (ctx: PlaywrightCrawlingContext, error: Error) => {
    const url = ctx.request.url;

    logger.error({ taskId, url, error: error.message }, 'Request failed');

    await Task.updateOne(
      { taskId },
      {
        $inc: { 'progress.failed': 1, 'result.stats.failed': 1 },
        $push: {
          'result.errors': {
            url,
            error: error.message,
            timestamp: new Date(),
          },
        },
      }
    );
  };
}
