import { PlaywrightCrawler, Configuration, ProxyConfiguration } from 'crawlee';
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
            const username = options.auth.credentials.username || '';
            const password = options.auth.credentials.password || '';
            const encoded = Buffer.from(`${username}:${password}`).toString('base64');
            extraHeaders['Authorization'] = `Basic ${encoded}`;
            break;
          }
          case 'bearer': {
            const token = options.auth.credentials.token;
            if (token) {
              extraHeaders['Authorization'] = `Bearer ${token}`;
            }
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
  if (options.rateLimit && options.rateLimit.perSeconds > 0) {
    maxRequestsPerMinute = Math.floor(
      (options.rateLimit.maxRequests / options.rateLimit.perSeconds) * 60
    );
  }

  // Configure proxy rotation (task-level overrides global config)
  let proxyConfiguration: ProxyConfiguration | undefined;
  const proxyUrls = options.proxy?.urls?.length
    ? options.proxy.urls
    : config.proxy?.urls?.length
      ? config.proxy.urls
      : undefined;
  if (proxyUrls && proxyUrls.length > 0) {
    proxyConfiguration = new ProxyConfiguration({ proxyUrls });
  }

  const crawler = new PlaywrightCrawler(
    {
      requestHandler: createRequestHandler(taskId, options),
      failedRequestHandler: createFailedRequestHandler(taskId),
      maxCrawlDepth: options.maxDepth,
      maxRequestsPerCrawl: options.maxPages,
      maxRequestsPerMinute,
      maxConcurrency: config.worker.concurrency,
      proxyConfiguration,
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
