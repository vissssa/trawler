const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// EJS 模板引擎 + 布局
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// 静态资源
app.use('/public', express.static(path.join(__dirname, 'public')));

// ==================== API 端点（供动态页面 fetch） ====================

app.get('/api/posts', (req, res) => {
  res.json([
    {
      id: 1,
      title: '人工智能的发展历程',
      summary: '从图灵测试到大语言模型，AI 经历了漫长而曲折的发展之路。',
      content:
        '人工智能（Artificial Intelligence）的概念最早由约翰·麦卡锡在 1956 年的达特茅斯会议上提出。此后经历了多次繁荣与寒冬：1960 年代的符号推理、1980 年代的专家系统、2010 年代的深度学习革命，直到今天的大语言模型时代。每一次突破都重新定义了人们对"智能"的理解。',
      author: '张三',
      date: '2026-03-15',
      tags: ['AI', '深度学习', '历史'],
    },
    {
      id: 2,
      title: 'Web 爬虫技术原理',
      summary: '了解现代网页爬虫的工作原理，从 HTTP 请求到无头浏览器渲染。',
      content:
        '网页爬虫（Web Crawler）是自动浏览互联网并收集信息的程序。现代爬虫不仅需要处理静态 HTML，还要应对 JavaScript 动态渲染的页面。Playwright 和 Puppeteer 等无头浏览器工具可以完整执行页面中的 JavaScript，获取最终渲染后的 DOM 内容。结合 BullMQ 等任务队列，可以实现高效的分布式爬取。',
      author: '李四',
      date: '2026-03-10',
      tags: ['爬虫', 'Playwright', 'Node.js'],
    },
    {
      id: 3,
      title: 'MongoDB 数据建模最佳实践',
      summary: '文档型数据库的设计哲学与关系型数据库截然不同。',
      content:
        'MongoDB 采用灵活的文档模型，设计时应遵循"按查询模式建模"的原则。嵌入式文档适合一对一和一对少的关系，引用适合一对多和多对多。合理使用索引、聚合管道和变更流，可以充分发挥 MongoDB 的性能优势。在 Trawler 项目中，Task 模型使用了原子操作（$inc、$push）来安全更新爬取进度。',
      author: '王五',
      date: '2026-03-05',
      tags: ['MongoDB', '数据库', '架构'],
    },
  ]);
});

app.get('/api/quotes', (req, res) => {
  // 模拟延迟加载
  const delay = parseInt(req.query.delay) || 0;
  setTimeout(() => {
    res.json([
      { text: '学而不思则罔，思而不学则殆。', author: '孔子' },
      { text: '千里之行，始于足下。', author: '老子' },
      { text: '知之为知之，不知为不知，是知也。', author: '孔子' },
      { text: '天行健，君子以自强不息。', author: '《周易》' },
      { text: '路漫漫其修远兮，吾将上下而求索。', author: '屈原' },
      { text: '不积跬步，无以至千里。', author: '荀子' },
      { text: '工欲善其事，必先利其器。', author: '孔子' },
      { text: '三人行，必有我师焉。', author: '孔子' },
    ]);
  }, delay);
});

// ==================== 首页 ====================

app.get('/', (req, res) => {
  res.render('pages/index', { title: 'Trawler 测试站' });
});

// ==================== 静态内容页面 ====================

app.get('/static/article', (req, res) => {
  res.render('pages/static/article', { title: '深入理解 Node.js 事件循环' });
});

app.get('/static/about', (req, res) => {
  res.render('pages/static/about', { title: '关于本站' });
});

// ==================== JS 动态渲染页面 ====================

app.get('/dynamic/fetch-content', (req, res) => {
  res.render('pages/dynamic/fetch-content', { title: 'API 动态加载示例' });
});

app.get('/dynamic/lazy-list', (req, res) => {
  res.render('pages/dynamic/lazy-list', { title: '延迟加载列表' });
});

// ==================== 多层级链接结构（博客） ====================

const blogPosts = [
  { id: 1, title: 'TypeScript 5.0 新特性一览', category: '前端', date: '2026-03-18' },
  { id: 2, title: 'Docker 容器化部署实战', category: '运维', date: '2026-03-15' },
  { id: 3, title: 'Redis 缓存策略详解', category: '后端', date: '2026-03-12' },
  { id: 4, title: 'Kubernetes 入门指南', category: '运维', date: '2026-03-08' },
  { id: 5, title: 'GraphQL vs REST API 对比', category: '架构', date: '2026-03-01' },
];

app.get('/blog', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 3;
  const total = blogPosts.length;
  const totalPages = Math.ceil(total / perPage);
  const posts = blogPosts.slice((page - 1) * perPage, page * perPage);
  res.render('pages/blog/index', { title: '技术博客', posts, page, totalPages });
});

app.get('/blog/post/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const post = blogPosts.find((p) => p.id === id);
  if (!post) return res.status(404).render('pages/edge/not-found', { title: '页面未找到' });
  // 关联文章
  const related = blogPosts.filter((p) => p.id !== id).slice(0, 2);
  res.render('pages/blog/post', { title: post.title, post, related });
});

app.get('/blog/category/:name', (req, res) => {
  const category = req.params.name;
  const posts = blogPosts.filter((p) => p.category === category);
  res.render('pages/blog/category', { title: `分类：${category}`, posts, category });
});

// ==================== CSS 选择器过滤 ====================

app.get('/selectors/mixed', (req, res) => {
  res.render('pages/selectors/mixed', { title: 'CSS 选择器测试页' });
});

// ==================== 长页面 + 富媒体 ====================

app.get('/media/long-page', (req, res) => {
  res.render('pages/media/long-page', { title: '超长页面测试' });
});

app.get('/media/gallery', (req, res) => {
  res.render('pages/media/gallery', { title: '富媒体画廊' });
});

// ==================== 慢响应/错误页面 ====================

app.get('/edge/slow', (req, res) => {
  const delay = parseInt(req.query.delay) || 5000;
  setTimeout(() => {
    res.render('pages/edge/slow', { title: '慢响应页面', delay });
  }, delay);
});

app.get('/edge/error-500', (req, res) => {
  res.status(500).render('pages/edge/error-500', { title: '服务器错误' });
});

app.get('/edge/not-found', (req, res) => {
  res.status(404).render('pages/edge/not-found', { title: '页面未找到' });
});

// ==================== iframe 嵌套 ====================

app.get('/iframe/nested', (req, res) => {
  res.render('pages/iframe/nested', { title: 'iframe 嵌套测试' });
});

app.get('/iframe/embed-content', (req, res) => {
  res.render('pages/iframe/embed-content', { title: '被嵌入的内容', layout: false });
});

// ==================== 404 兜底 ====================

app.use((req, res) => {
  res.status(404).render('pages/edge/not-found', { title: '页面未找到' });
});

// ==================== 启动服务器 ====================

app.listen(PORT, () => {
  console.log(`🌐 示例网站已启动: http://localhost:${PORT}`);
  console.log(`📋 页面列表:`);
  console.log(`   首页:         http://localhost:${PORT}/`);
  console.log(`   静态页面:     http://localhost:${PORT}/static/article`);
  console.log(`   动态渲染:     http://localhost:${PORT}/dynamic/fetch-content`);
  console.log(`   博客:         http://localhost:${PORT}/blog`);
  console.log(`   选择器测试:   http://localhost:${PORT}/selectors/mixed`);
  console.log(`   长页面:       http://localhost:${PORT}/media/long-page`);
  console.log(`   富媒体:       http://localhost:${PORT}/media/gallery`);
  console.log(`   慢响应:       http://localhost:${PORT}/edge/slow`);
  console.log(`   iframe:       http://localhost:${PORT}/iframe/nested`);
});
