import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { PlaywrightCrawlingContext } from 'crawlee';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { Task } from '../models/Task';
import type { CrawlOptions } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('worker:handlers');
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// Remove script/style/noscript tags from Markdown output
turndown.remove(['script', 'style', 'noscript']);

export function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/** Extract content matching CSS selectors; falls back to full HTML if no match */
export function extractBySelectors(html: string, selectors: string | string[]): string {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const $ = cheerio.load(html);
  const fragments: string[] = [];

  for (const sel of selectorList) {
    $(sel).each((_, el) => {
      fragments.push($.html(el));
    });
  }

  return fragments.length > 0 ? fragments.join('\n') : html;
}

/** Resolve relative href/src attributes to absolute URLs */
export function resolveRelativeUrls(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  $('[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        $(el).attr('href', new URL(href, baseUrl).href);
      } catch {
        // ignore invalid URLs
      }
    }
  });

  $('[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      try {
        $(el).attr('src', new URL(src, baseUrl).href);
      } catch {
        // ignore invalid URLs
      }
    }
  });

  return $.html();
}

export function createRequestHandler(taskId: string, options: CrawlOptions = {}) {
  return async (ctx: PlaywrightCrawlingContext) => {
    const { page, request, enqueueLinks } = ctx;
    const url = request.url;

    logger.info({ taskId, url }, 'Processing page');

    // Update current URL in progress
    await Task.updateOne({ taskId }, { $set: { 'progress.currentUrl': url } });

    // Wait for dynamic content to finish rendering
    await page.waitForLoadState('networkidle').catch(() => {
      logger.debug({ taskId, url }, 'networkidle timeout, proceeding with current content');
    });

    // Get page HTML
    const html = await page.content();

    // Save HTML file
    const taskDir = path.join(config.storage.dataDir, taskId);
    await mkdir(taskDir, { recursive: true });

    const fileName = `${md5(url)}.html`;
    const filePath = path.join(taskDir, fileName);
    await writeFile(filePath, html, 'utf-8');

    const fileSize = Buffer.byteLength(html, 'utf-8');

    // Convert HTML to Markdown (with optional selector filtering + link absolutization)
    let markdownSource = html;
    if (options.contentSelector) {
      markdownSource = extractBySelectors(markdownSource, options.contentSelector);
    }
    markdownSource = resolveRelativeUrls(markdownSource, url);
    const markdown = turndown.turndown(markdownSource);
    const mdFileName = `${md5(url)}.md`;
    const mdFilePath = path.join(taskDir, mdFileName);
    await writeFile(mdFilePath, markdown, 'utf-8');

    const mdFileSize = Buffer.byteLength(markdown, 'utf-8');

    // Atomic update: increment progress and push file results
    await Task.updateOne(
      { taskId },
      {
        $inc: { 'progress.completed': 1, 'result.stats.success': 1 },
        $push: {
          'result.files': {
            $each: [
              {
                type: 'html',
                url,
                path: filePath,
                size: fileSize,
                mimeType: 'text/html',
                timestamp: new Date(),
              },
              {
                type: 'markdown',
                url,
                path: mdFilePath,
                size: mdFileSize,
                mimeType: 'text/markdown',
                timestamp: new Date(),
              },
            ],
          },
        },
      }
    );

    logger.info({ taskId, url, filePath, mdFilePath, fileSize, mdFileSize }, 'Page saved');

    // Enqueue discovered links (same-domain only)
    const enqueuedInfo = await enqueueLinks({ strategy: 'same-domain' });
    const newlyEnqueued = enqueuedInfo.processedRequests.filter(
      (r) => r.wasAlreadyPresent === false
    ).length;

    // Update progress.total to account for newly discovered URLs
    if (newlyEnqueued > 0) {
      await Task.updateOne({ taskId }, { $inc: { 'progress.total': newlyEnqueued } });
    }

    logger.debug({ taskId, url, enqueued: newlyEnqueued }, 'Enqueued links');
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
