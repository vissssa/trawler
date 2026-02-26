import { PlaywrightCrawler, Configuration, ProxyConfiguration } from 'crawlee';
import { createCrawler } from '../../src/worker/crawler';

jest.mock('crawlee');
jest.mock('../../src/worker/handlers', () => ({
  createRequestHandler: jest.fn(() => jest.fn()),
  createFailedRequestHandler: jest.fn(() => jest.fn()),
}));
jest.mock('../../src/config', () => ({
  config: {
    worker: { concurrency: 3 },
    proxy: { urls: [] },
  },
}));
jest.mock('../../src/utils/logger', () => {
  const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger), logger: mockLogger };
});

describe('createCrawler', () => {
  let MockPlaywrightCrawler: jest.MockedClass<typeof PlaywrightCrawler>;

  beforeEach(() => {
    jest.clearAllMocks();
    MockPlaywrightCrawler = PlaywrightCrawler as jest.MockedClass<typeof PlaywrightCrawler>;
    MockPlaywrightCrawler.mockImplementation(() => ({} as any));
    (Configuration as jest.MockedClass<typeof Configuration>).mockImplementation(() => ({} as any));
  });

  it('应该使用默认选项创建爬虫', () => {
    createCrawler('task_1', {});

    expect(MockPlaywrightCrawler).toHaveBeenCalledTimes(1);
    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts).toMatchObject({
      maxConcurrency: 3,
      launchContext: {
        launchOptions: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      },
    });
  });

  it('应该映射 maxDepth/maxPages 选项', () => {
    createCrawler('task_2', {
      maxDepth: 5,
      maxPages: 100,
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.maxCrawlDepth).toBe(5);
    expect(crawlerOpts?.maxRequestsPerCrawl).toBe(100);
  });

  it('应该计算 maxRequestsPerMinute', () => {
    createCrawler('task_3', {
      rateLimit: { maxRequests: 10, perSeconds: 5 },
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.maxRequestsPerMinute).toBe(120);
  });

  it('应该为 userAgent 注入 preNavigationHooks', () => {
    createCrawler('task_4', { userAgent: 'TestBot/1.0' });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.preNavigationHooks).toHaveLength(1);
  });

  it('无 userAgent/headers/auth 时不应有 preNavigationHooks', () => {
    createCrawler('task_5', {});

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.preNavigationHooks).toHaveLength(0);
  });

  it('应该为每个任务创建独立的 Configuration', () => {
    createCrawler('task_6', {});

    expect(Configuration).toHaveBeenCalledWith(
      expect.objectContaining({
        persistStorage: false,
        storageClientOptions: {
          localDataDirectory: '/tmp/crawlee-task_6',
        },
      })
    );
  });

  it('basic auth 应生成正确的 Authorization header', async () => {
    createCrawler('task_7', {
      auth: {
        type: 'basic',
        credentials: { username: 'user', password: 'pass' },
      },
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    const hook = crawlerOpts?.preNavigationHooks?.[0];
    const mockPage = { setExtraHTTPHeaders: jest.fn() };
    await (hook as any)({ page: mockPage, request: { url: 'https://example.com' } });

    const expected = Buffer.from('user:pass').toString('base64');
    expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ Authorization: `Basic ${expected}` })
    );
  });

  it('bearer auth 应生成正确的 Authorization header', async () => {
    createCrawler('task_8', {
      auth: {
        type: 'bearer',
        credentials: { token: 'my-token' },
      },
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    const hook = crawlerOpts?.preNavigationHooks?.[0];
    const mockPage = { setExtraHTTPHeaders: jest.fn() };
    await (hook as any)({ page: mockPage, request: { url: 'https://example.com' } });

    expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ Authorization: 'Bearer my-token' })
    );
  });

  it('cookie auth 应生成正确的 Cookie header', async () => {
    createCrawler('task_9', {
      auth: {
        type: 'cookie',
        credentials: { cookies: { session: 'abc123', lang: 'zh' } },
      },
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    const hook = crawlerOpts?.preNavigationHooks?.[0];
    const mockPage = { setExtraHTTPHeaders: jest.fn() };
    await (hook as any)({ page: mockPage, request: { url: 'https://example.com' } });

    expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ Cookie: 'session=abc123; lang=zh' })
    );
  });

  it('应该将 proxy.urls 传递给 ProxyConfiguration', () => {
    createCrawler('task_proxy', {
      proxy: { urls: ['http://proxy1:8080', 'http://proxy2:8080'] },
    });

    expect(ProxyConfiguration).toHaveBeenCalledWith({
      proxyUrls: ['http://proxy1:8080', 'http://proxy2:8080'],
    });

    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.proxyConfiguration).toBeDefined();
  });

  it('无 proxy 时不应创建 ProxyConfiguration', () => {
    createCrawler('task_no_proxy', {});

    expect(ProxyConfiguration).not.toHaveBeenCalled();
    const crawlerOpts = MockPlaywrightCrawler.mock.calls[0][0];
    expect(crawlerOpts?.proxyConfiguration).toBeUndefined();
  });
});
