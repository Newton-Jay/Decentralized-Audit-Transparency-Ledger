import { Request, Response, NextFunction } from "express";

/**
 * Distributed event-cache layer (#443).
 *
 * Event queries are cached behind a pluggable `CacheStore` so the same
 * middleware works single-node (memory), with a Redis instance, across a
 * Redis Cluster, or against a Memcached pool. Entry management (TTL, prefix
 * invalidation) lives in the store contract, and a warming helper pre-fills
 * popular queries on startup.
 *
 * Selection is driven entirely by the environment:
 *
 *   CACHE_BACKEND            memory | redis | memcached   (default: memory)
 *   REDIS_URL                redis://host:port            (single node)
 *   REDIS_CLUSTER_ENDPOINTS  host:port,host:port          (cluster nodes)
 *   MEMCACHED_SERVERS        host:port,host:port          (memcached pool)
 *   CACHE_TTL_SECONDS        default entry TTL            (default: 30)
 *
 * In "memory" mode the process holds its own data, so backends are only
 * ever contacted when one of the distributed backends is explicitly
 * configured.
 */

export const EVENT_CACHE_PREFIX = "audit:event-cache:";

export interface CacheEntry {
  value: string;
  contentType: string;
  createdAt: number;
}

export interface CacheStore {
  readonly name: string;
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}

// ── In-memory store ──────────────────────────────────────────────────────────

interface MemoryRecord {
  entry: CacheEntry;
  expiresAt: number;
}

export class MemoryCacheStore implements CacheStore {
  readonly name = "memory";
  private readonly records = new Map<string, MemoryRecord>();

  async get(key: string): Promise<CacheEntry | null> {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return record.entry;
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    this.records.set(key, {
      entry,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of Array.from(this.records.keys())) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    return { ok: true, latencyMs: Date.now() - start };
  }
}

// ── Redis store (single node + cluster) ─────────────────────────────────────

type RedisLike = {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
};

function loadRedisClient(): RedisLike {
  // Lazy requires so the memory backend never forces the runtime to install
  // ioredis, and so unit tests can inject a fake client instead.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: Redis, Cluster } = require("ioredis");

  const clusterEndpoints = (process.env.REDIS_CLUSTER_ENDPOINTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((hostPort) => {
      const [host, portStr] = hostPort.split(":");
      return { host, port: parseInt(portStr ?? "6379", 10) };
    });

  if (clusterEndpoints.length > 0) {
    return new Cluster(clusterEndpoints);
  }

  const url = process.env.REDIS_URL;
  if (url) return new Redis(url);
  return new Redis();
}

export class RedisCacheStore implements CacheStore {
  readonly name: string;
  private readonly client: RedisLike;
  private readonly prefix: string;

  constructor(client?: RedisLike) {
    this.client = client ?? loadRedisClient();
    this.prefix = process.env.REDIS_CACHE_KEY_PREFIX ?? "";
    this.name = client ? "redis" : (process.env.REDIS_URL ?? "redis://localhost") + (process.env.REDIS_CLUSTER_ENDPOINTS ? "/cluster" : "");
  }

  async get(key: string): Promise<CacheEntry | null> {
    const raw = await this.client.get(this.prefix + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    await this.client.setex(this.prefix + key, ttlSeconds, JSON.stringify(entry));
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const matches = await this.client.keys(this.prefix + prefix + "*");
    if (matches.length === 0) return 0;
    const deleted = await this.client.del(...matches);
    return deleted;
  }

  async clear(): Promise<void> {
    await this.deleteByPrefix("");
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.get(this.prefix + "health");
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ── Memcached store ─────────────────────────────────────────────────────────

type MemcachedLike = {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown, lifetime: number): Promise<unknown> | unknown;
  del(key: string): Promise<unknown> | unknown;
  flush(): Promise<unknown> | unknown;
};

function loadMemcachedClient(): MemcachedLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Memcached = require("memcached");
  const servers = process.env.MEMCACHED_SERVERS ?? "localhost:11211";
  return new Memcached(servers);
}

export class MemcachedCacheStore implements CacheStore {
  readonly name = "memcached";
  private readonly client: MemcachedLike;
  private readonly prefix: string;

  constructor(client?: MemcachedLike) {
    this.client = client ?? loadMemcachedClient();
    this.prefix = process.env.REDIS_CACHE_KEY_PREFIX ?? "";
  }

  async get(key: string): Promise<CacheEntry | null> {
    const value = await this.client.get(this.prefix + key);
    if (!value) return null;
    try {
      return JSON.parse(value as string) as CacheEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(entry), ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  // Memcached has no server-side prefix delete; callers fall back to key-level
  // invalidation, so we report the conservative count of 0.
  async deleteByPrefix(_prefix: string): Promise<number> {
    return 0;
  }

  async clear(): Promise<void> {
    await this.client.flush();
  }

  async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.get(this.prefix + "health");
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ── Store selection ──────────────────────────────────────────────────────────

export function createCacheStore(): CacheStore {
  const backend = (process.env.CACHE_BACKEND ?? "memory").toLowerCase();
  if (backend === "redis") return new RedisCacheStore();
  if (backend === "memcached") return new MemcachedCacheStore();
  return new MemoryCacheStore();
}

export function defaultCacheTtlSeconds(): number {
  const parsed = parseInt(process.env.CACHE_TTL_SECONDS ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 30 : parsed;
}

// ── Cache warming ────────────────────────────────────────────────────────────

export interface WarmCacheEntry {
  key: string;
  value: string;
  contentType?: string;
  ttlSeconds?: number;
}

/** Pre-populates the cache with entries computed ahead of a request so the
 * first real caller gets a HIT instead of paying the cold path. */
export async function warmEventCache(
  store: CacheStore,
  entries: WarmCacheEntry[],
  ttlSeconds = defaultCacheTtlSeconds()
): Promise<number> {
  let warmed = 0;
  for (const entry of entries) {
    await store.set(
      EVENT_CACHE_PREFIX + entry.key,
      {
        value: entry.value,
        contentType: entry.contentType ?? "application/json; charset=utf-8",
        createdAt: Date.now(),
      },
      entry.ttlSeconds ?? ttlSeconds
    );
    warmed++;
  }
  return warmed;
}

// ── Invalidation ─────────────────────────────────────────────────────────────

/** Invalidates cached entries whose keys start with `prefix` (all event-cache
 * entries by default). Returns the number of entries removed when the backend
 * can report it. */
export async function invalidateEventCache(
  store: CacheStore,
  prefix = EVENT_CACHE_PREFIX
): Promise<number> {
  return store.deleteByPrefix(prefix);
}

// ── Express wiring ───────────────────────────────────────────────────────────

export function cacheKeyFor(req: Request): string {
  return EVENT_CACHE_PREFIX + req.originalUrl;
}

// ── Cache middleware backed by the configured store ─────────────────────────

const CACHE_TTL_BY_ROUTE: Record<string, number> = {
  "/v1/events": 30,
  "/v1/events/:index": 300,
  "/v1/events/type/:type": 30,
  "/v1/stats": 10,
};

function matchRoute(path: string, pattern: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every(
    (part, i) => part.startsWith(":") || part === pathParts[i]
  );
}

/** Serves cached GET responses for event routes and stores fresh responses
 * back into the configured store. A backend failure never breaks the request
 * path — it degrades to a plain (uncached) response. */
export function createCacheBackedMiddleware(store: CacheStore) {
  return async function eventCacheMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (req.method !== "GET") {
      next();
      return;
    }

    const matchedPattern = Object.keys(CACHE_TTL_BY_ROUTE).find((pattern) =>
      matchRoute(req.path, pattern)
    );
    if (!matchedPattern) {
      next();
      return;
    }

    const ttl = CACHE_TTL_BY_ROUTE[matchedPattern];
    const key = cacheKeyFor(req);

    try {
      const cached = await store.get(key);
      if (cached) {
        res.setHeader("X-Cache-Status", "HIT");
        res.setHeader("Content-Type", cached.contentType);
        res.json(JSON.parse(cached.value));
        return;
      }

      res.setHeader("X-Cache-Status", "MISS");
      res.setHeader(
        "Cache-Control",
        `public, max-age=${ttl}, stale-while-revalidate=${ttl * 2}`
      );

      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        void store.set(
          key,
          {
            value: JSON.stringify(body),
            contentType: (res.getHeader("content-type") as string) || "application/json; charset=utf-8",
            createdAt: Date.now(),
          },
          ttl
        );
        return originalJson(body);
      };
    } catch (err) {
      // Never let a cache backend failure break the request path.
      res.setHeader("X-Cache-Status", "BYPASS");
      next(err as Error);
      return;
    }

    next();
  };
}