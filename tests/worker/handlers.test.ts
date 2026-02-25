import { createHash } from 'crypto';
import {
  md5,
  extractBySelectors,
  resolveRelativeUrls,
  createRequestHandler,
  createFailedRequestHandler,
} from '../../src/worker/handlers';
import { Task } from '../../src/models/Task';
import { mkdir, writeFile } from 'fs/promises';

// Mock dependencies that handlers.ts imports at module level
jest.mock('../../src/models/Task');
jest.mock('fs/promises');
jest.mock('../../src/config', () => ({
  config: {
    storage: { dataDir: '/tmp/test-data' },
  },
}));
jest.mock('../../src/utils/logger', () => {
  const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger), logger: mockLogger };
});

describe('handlers 辅助函数', () => {
  describe('md5', () => {
    it('应该返回一致的 MD5 哈希值', () => {
      const hash = md5('https://example.com');
      expect(hash).toBe(createHash('md5').update('https://example.com').digest('hex'));
    });

    it('不同输入应该返回不同哈希', () => {
      expect(md5('a')).not.toBe(md5('b'));
    });
  });

  describe('extractBySelectors', () => {
    const html =
      '<html><body><div class="content">Hello</div><div class="sidebar">Ad</div></body></html>';

    it('应该提取匹配选择器的内容', () => {
      const result = extractBySelectors(html, '.content');
      expect(result).toContain('Hello');
      expect(result).not.toContain('Ad');
    });

    it('应该支持多个选择器', () => {
      const result = extractBySelectors(html, ['.content', '.sidebar']);
      expect(result).toContain('Hello');
      expect(result).toContain('Ad');
    });

    it('无匹配时应回退到完整 HTML', () => {
      const result = extractBySelectors(html, '.nonexistent');
      expect(result).toBe(html);
    });
  });

  describe('resolveRelativeUrls', () => {
    it('应该将相对 href 转换为绝对 URL', () => {
      const html = '<a href="/about">About</a>';
      const result = resolveRelativeUrls(html, 'https://example.com/page');
      expect(result).toContain('https://example.com/about');
    });

    it('应该将相对 src 转换为绝对 URL', () => {
      const html = '<img src="logo.png">';
      const result = resolveRelativeUrls(html, 'https://example.com/page/');
      expect(result).toContain('https://example.com/page/logo.png');
    });

    it('应该保留已经是绝对 URL 的链接', () => {
      const html = '<a href="https://other.com/page">Link</a>';
      const result = resolveRelativeUrls(html, 'https://example.com');
      expect(result).toContain('https://other.com/page');
    });

    it('应该忽略无效 URL', () => {
      const html = '<a href="javascript:void(0)">Click</a>';
      const result = resolveRelativeUrls(html, 'https://example.com');
      expect(result).toContain('javascript:void(0)');
    });
  });
});

describe('createRequestHandler', () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (Task.updateOne as jest.Mock).mockResolvedValue({});
    (mkdir as jest.Mock).mockResolvedValue(undefined);
    (writeFile as jest.Mock).mockResolvedValue(undefined);

    mockCtx = {
      page: {
        content: jest.fn().mockResolvedValue('<html><body><h1>Hello</h1></body></html>'),
        waitForLoadState: jest.fn().mockResolvedValue(undefined),
      },
      request: { url: 'https://example.com/page1' },
      enqueueLinks: jest.fn().mockResolvedValue({ processedRequests: [] }),
    };
  });

  it('应该保存 HTML 和 Markdown 文件', async () => {
    const handler = createRequestHandler('task_test', {});
    await handler(mockCtx);

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('task_test'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.html$/),
      expect.any(String),
      'utf-8'
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.md$/),
      expect.any(String),
      'utf-8'
    );
  });

  it('应该更新 MongoDB 进度和文件结果', async () => {
    const handler = createRequestHandler('task_test', {});
    await handler(mockCtx);

    expect(Task.updateOne).toHaveBeenCalledWith(
      { taskId: 'task_test' },
      { $set: { 'progress.currentUrl': 'https://example.com/page1' } }
    );
    expect(Task.updateOne).toHaveBeenCalledWith(
      { taskId: 'task_test' },
      expect.objectContaining({
        $inc: { 'progress.completed': 1, 'result.stats.success': 1 },
        $push: expect.objectContaining({
          'result.files': expect.objectContaining({
            $each: expect.any(Array),
          }),
        }),
      })
    );
  });

  it('应该调用 enqueueLinks 发现链接', async () => {
    const handler = createRequestHandler('task_test', {});
    await handler(mockCtx);
    expect(mockCtx.enqueueLinks).toHaveBeenCalledWith({ strategy: 'same-domain' });
  });

  it('带 contentSelector 时应该过滤内容', async () => {
    const htmlWithSelector =
      '<html><body><div class="main">Main Content</div><div class="ad">Ad Content</div></body></html>';
    mockCtx.page.content.mockResolvedValue(htmlWithSelector);

    const handler = createRequestHandler('task_test', { contentSelector: '.main' });
    await handler(mockCtx);

    // Find the markdown writeFile call (the one ending in .md)
    const mdWriteCall = (writeFile as jest.Mock).mock.calls.find((call: any[]) =>
      call[0].endsWith('.md')
    );
    expect(mdWriteCall).toBeDefined();
    expect(mdWriteCall[1]).toContain('Main Content');
    expect(mdWriteCall[1]).not.toContain('Ad Content');
  });

  it('networkidle 超时时应继续处理', async () => {
    mockCtx.page.waitForLoadState.mockRejectedValue(new Error('timeout'));
    const handler = createRequestHandler('task_test', {});
    await expect(handler(mockCtx)).resolves.not.toThrow();
  });
});

describe('createFailedRequestHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('应该记录失败信息到 MongoDB', async () => {
    (Task.updateOne as jest.Mock).mockResolvedValue({});
    const handler = createFailedRequestHandler('task_fail');
    const mockCtx = { request: { url: 'https://example.com/bad' } } as any;
    const error = new Error('Connection refused');

    await handler(mockCtx, error);

    expect(Task.updateOne).toHaveBeenCalledWith(
      { taskId: 'task_fail' },
      {
        $inc: { 'progress.failed': 1, 'result.stats.failed': 1 },
        $push: {
          'result.errors': {
            url: 'https://example.com/bad',
            error: 'Connection refused',
            timestamp: expect.any(Date),
          },
        },
      }
    );
  });
});
