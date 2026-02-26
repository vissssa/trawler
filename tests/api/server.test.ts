import { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { createServer } from '../../src/api/server';

// Set mongoose readyState to 1 (connected) for /ready endpoint test
Object.defineProperty(mongoose.connection, 'readyState', { value: 1, writable: true });

// Mock config
jest.mock('../../src/config', () => ({
  config: {
    env: 'test',
    api: {
      port: 3001,
    },
  },
}));

// Mock metrics
jest.mock('../../src/services/metrics', () => ({
  metricsRegistry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
  httpRequestDuration: { observe: jest.fn() },
  tasksTotal: { inc: jest.fn() },
  tasksCurrent: {},
  queueDepth: {},
  pagesCrawledTotal: { inc: jest.fn() },
}));

// Mock logger
jest.mock('../../src/utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
    level: 'info',
  };
  return {
    createLogger: jest.fn(() => mockLogger),
    rootLogger: mockLogger,
    logger: mockLogger,
  };
});

// Mock queue service to avoid Redis connection
jest.mock('../../src/services/queue', () => ({
  getQueueService: jest.fn(() => ({
    addJob: jest.fn(),
    removeJob: jest.fn(),
    getStats: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
  })),
}));

describe('Fastify Server', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('Health Endpoints', () => {
    it('should respond to health check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeDefined();
    });

    it('should respond to ready check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
      expect(body.timestamp).toBeDefined();
      expect(body.checks.database).toBe(true);
      expect(body.checks.redis).toBe(true);
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/unknown-route',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Found');
      expect(body.message).toContain('Route GET /unknown-route not found');
    });

    it('should return 404 for unknown POST routes', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/unknown',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Found');
      expect(body.message).toContain('POST /unknown');
    });
  });

  describe('Error Handler', () => {
    it('should handle validation errors', async () => {
      // Register a route with validation
      server.post('/test-validation', {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
            },
          },
        },
        handler: async (request, reply) => {
          return { success: true };
        },
      });

      const response = await server.inject({
        method: 'POST',
        url: '/test-validation',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation Error');
    });

    it('should handle custom errors with statusCode', async () => {
      server.get('/test-error', async (request, reply) => {
        const error = new Error('Custom error') as any;
        error.statusCode = 403;
        error.name = 'ForbiddenError';
        throw error;
      });

      const response = await server.inject({
        method: 'GET',
        url: '/test-error',
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('ForbiddenError');
      expect(body.message).toBe('Custom error');
    });

    it('should handle generic errors as 500', async () => {
      server.get('/test-generic-error', async (request, reply) => {
        throw new Error('Unexpected error');
      });

      const response = await server.inject({
        method: 'GET',
        url: '/test-generic-error',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal Server Error');
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://example.com',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Server Configuration', () => {
    it('should have logger configured', () => {
      expect(server.log).toBeDefined();
    });
  });

  describe('Swagger', () => {
    it('should serve Swagger UI at /docs', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs/',
      });

      // Swagger UI returns 200 with HTML content
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('should serve OpenAPI JSON at /docs/json', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs/json',
      });

      expect(response.statusCode).toBe(200);
      const spec = JSON.parse(response.body);
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info.title).toBe('Trawler API');
      expect(spec.info.version).toBe('1.0.0');
      expect(spec.paths).toBeDefined();
      expect(spec.paths['/tasks']).toBeDefined();
      expect(spec.paths['/health']).toBeDefined();
    });
  });
});
