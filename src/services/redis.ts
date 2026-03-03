import Redis, { Cluster } from 'ioredis';
import { config } from '../config';

export type RedisConnection = Redis | Cluster;

/**
 * Normalize non-standard Redis URL schemes so ioredis can parse them.
 * tcp:// → redis://, everything else is left as-is.
 */
function normalizeRedisUrl(url: string): string {
  return url.replace(/^tcp:\/\//, 'redis://');
}

/**
 * Parse a Redis URL into host, port, and password components.
 */
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  let parsed: URL;
  try {
    parsed = new URL(normalizeRedisUrl(url));
  } catch {
    throw new Error(`Invalid REDIS_URL: ${url}`);
  }
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || 6379,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/**
 * Create a Redis connection (standalone or cluster) based on config.
 *
 * When `config.redis.isCluster` is true, returns a `Redis.Cluster` instance
 * that handles MOVED/ASK redirections automatically.
 */
export function createRedisConnection(
  options: { maxRetriesPerRequest?: number | null } = {}
): RedisConnection {
  const { url, isCluster } = config.redis;

  if (isCluster) {
    const { host, port, password } = parseRedisUrl(url);
    return new Cluster([{ host, port }], {
      redisOptions: {
        password,
        maxRetriesPerRequest: options.maxRetriesPerRequest ?? null,
      },
      enableOfflineQueue: true,
    });
  }

  return new Redis(normalizeRedisUrl(url), {
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? null,
  });
}

/**
 * BullMQ prefix for queue keys.
 * In cluster mode, uses {bull} hash tag to ensure all keys for a queue
 * land in the same hash slot.
 */
export function getBullMQPrefix(): string {
  return config.redis.isCluster ? '{bull}' : 'bull';
}
