import { createHash } from 'crypto';
import { md5, extractBySelectors, resolveRelativeUrls } from '../../src/worker/handlers';

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
