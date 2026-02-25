import { PlaywrightCrawler, Configuration } from 'crawlee';
import type { CrawlOptions } from '../models/Task';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { createRequestHandler, createFailedRequestHandler } from './handlers';

const logger = createLogger('worker:crawler');

export function createCrawler(taskId: string, options: CrawlOptions): PlaywrightCrawler {
  // Each task gets its own Crawlee Configuration to avoid state pollution
  const crawleeConfig = new Configuration({
    persistStorage: false,
    storageClientOptions: {
      localDataDirectory: `/tmp/crawlee-${taskId}`,
    },
  });

  // Build preNavigationHooks for userAgent, headers, and auth
  const preNavigationHooks: Array<
    (ctx: { page: import('playwright').Page; request: { url: string } }) => Promise<void>
  > = [];

  if (options.userAgent || options.headers || options.auth) {
    preNavigationHooks.push(async ({ page }) => {
      // Set custom headers
      const extraHeaders: Record<string, string> = {};

      if (options.userAgent) {
        extraHeaders['User-Agent'] = options.userAgent;
      }

      if (options.headers) {
        Object.assign(extraHeaders, options.headers);
      }

      // Handle auth
      if (options.auth) {
        switch (options.auth.type) {
          case 'basic': {
            const { username, password } = options.auth.credentials;
            const encoded = Buffer.from(`${username}:${password}`).toString('base64');
            extraHeaders['Authorization'] = `Basic ${encoded}`;
            break;
          }
          case 'bearer': {
            extraHeaders['Authorization'] = `Bearer ${options.auth.credentials.token}`;
            break;
          }
          case 'cookie': {
            if (options.auth.credentials.cookies) {
              const cookieStr = Object.entries(options.auth.credentials.cookies)
                .map(([k, v]) => `${k}=${v}`)
                .join('; ');
              extraHeaders['Cookie'] = cookieStr;
            }
            break;
          }
        }
      }

      if (Object.keys(extraHeaders).length > 0) {
        await page.setExtraHTTPHeaders(extraHeaders);
      }
    });
  }

  // Compute maxRequestsPerMinute from rateLimit
  let maxRequestsPerMinute: number | undefined;
  if (options.rateLimit) {
    maxRequestsPerMinute = Math.floor(
      (options.rateLimit.maxRequests / options.rateLimit.perSeconds) * 60
    );
  }

  const crawler = new PlaywrightCrawler(
    {
      requestHandler: createRequestHandler(taskId),
      failedRequestHandler: createFailedRequestHandler(taskId),
      maxCrawlDepth: options.maxDepth,
      maxRequestsPerCrawl: options.maxPages,
      navigationTimeoutSecs: options.timeout ? Math.floor(options.timeout / 1000) : undefined,
      maxRequestsPerMinute,
      maxConcurrency: config.worker.concurrency,
      preNavigationHooks,
      launchContext: {
        launchOptions: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      },
    },
    crawleeConfig
  );

  logger.info({ taskId, options }, 'Created crawler');
  return crawler;
}
