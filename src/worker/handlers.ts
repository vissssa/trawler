import { createHash } from 'crypto';
import { mkdir, writeFile, stat as fsStat } from 'fs/promises';
import path from 'path';
import type { PlaywrightCrawlingContext } from 'crawlee';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { Task } from '../models/Task';
import type { CrawlOptions } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { pagesCrawledTotal } from '../services/metrics';
import { assertValidTaskId } from '../utils/validation';

const logger = createLogger('worker:handlers');
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// Remove script/style/noscript tags from Markdown output
turndown.remove(['script', 'style', 'noscript']);

const MAX_SCREENSHOT_HEIGHT = 16384;

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
  assertValidTaskId(taskId);

  return async (ctx: PlaywrightCrawlingContext) => {
    const { page, request, enqueueLinks } = ctx;
    const url = request.url;

    logger.info({ taskId, url }, 'Processing page');

    // Wait for dynamic content to finish rendering
    await page.waitForLoadState('domcontentloaded').catch(() => {
      logger.debug({ taskId, url }, 'domcontentloaded timeout, proceeding with current content');
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

    // Build dynamic files list
    const filesToPush: Array<{
      type: string;
      url: string;
      path: string;
      size: number;
      mimeType: string;
      timestamp: Date;
    }> = [
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
    ];

    // Capture screenshot if requested
    if (options.captureScreenshot) {
      const screenshotFileName = `${md5(url)}.png`;
      const screenshotPath = path.join(taskDir, screenshotFileName);

      // Check page height — fallback to viewport screenshot if too tall
      let useFullPage = true;
      try {
        const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
        if (bodyHeight > MAX_SCREENSHOT_HEIGHT) {
          logger.debug({ taskId, url, bodyHeight }, 'Page too tall for fullPage screenshot, using viewport');
          useFullPage = false;
        }
      } catch {
        // If evaluation fails, default to viewport screenshot
        useFullPage = false;
      }

      await page.screenshot({ path: screenshotPath, fullPage: useFullPage });
      const screenshotStat = await fsStat(screenshotPath);
      filesToPush.push({
        type: 'screenshot',
        url,
        path: screenshotPath,
        size: screenshotStat.size,
        mimeType: 'image/png',
        timestamp: new Date(),
      });
      logger.debug({ taskId, url, screenshotPath }, 'Screenshot captured');
    }

    // Capture PDF if requested
    if (options.capturePdf) {
      const pdfFileName = `${md5(url)}.pdf`;
      const pdfPath = path.join(taskDir, pdfFileName);
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      const pdfStat = await fsStat(pdfPath);
      filesToPush.push({
        type: 'pdf',
        url,
        path: pdfPath,
        size: pdfStat.size,
        mimeType: 'application/pdf',
        timestamp: new Date(),
      });
      logger.debug({ taskId, url, pdfPath }, 'PDF captured');
    }

    // Atomic update: increment progress, push file results, and set currentUrl
    await Task.updateOne(
      { taskId },
      {
        $inc: { 'progress.completed': 1, 'result.stats.success': 1 },
        $set: { 'progress.currentUrl': url },
        $push: {
          'result.files': {
            $each: filesToPush,
          },
        },
      }
    );

    logger.info({ taskId, url, filePath, mdFilePath, fileSize, mdFileSize }, 'Page saved');
    pagesCrawledTotal.inc({ result: 'success' });

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
    pagesCrawledTotal.inc({ result: 'failed' });

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
