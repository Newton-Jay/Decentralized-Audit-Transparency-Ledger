import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  MemoryCacheStore,
  RedisCacheStore,
  MemcachedCacheStore,
  createCacheStore,
  createCacheBackedMiddleware,
  warmEventCache,
  invalidateEventCache,
  defaultCacheTtlSeconds,
  CacheStore,
} from "../src/eventCache";

function fakeBackend() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    async setex(key: string, _secs: number, value: string) {
      data.set(key, value);
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    },
    async keys(pattern: string) {
      return Array.from(data.keys()).filter((k) => k.startsWith(pattern.replace("*", "")));
    },
  };
}

function minApp(store: CacheStore) {
  const app = express();
  app.use(createCacheBackedMiddleware(store));
  app.get("/v1/stats", (_req, res) => res.json({ data: { totalEvents: 7 } }));
  app.get("/v1/events", (_req, res) =>
    res.json({ data: [{ index: 0, type: "payment" }] })
  );
  return app;
}

describe("MemoryCacheStore", () => {
  it("stores and retrieves entries with TTL", async () => {
    const store = new MemoryCacheStore();
    await store.set("k", { value: "{}", contentType: "application/json", createdAt: Date.now() }, 30);
    expect((await store.get("k"))?.value).toBe("{}");
  });

  it("treats expired entries as misses and removes them", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryCacheStore();
      await store.set("k", { value: "{}", contentType: "application/json", createdAt: Date.now() }, 1);
      vi.advanceTimersByTime(1500);
      expect(await store.get("k")).toBeNull();
      expect(await store.get("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes by key and by prefix", async () => {
    const store = new MemoryCacheStore();
    await store.set("audit:event-cache:a", { value: "1", contentType: "application/json", createdAt: Date.now() }, 30);
    await store.set("audit:event-cache:b", { value: "2", contentType: "application/json", createdAt: Date.now() }, 30);
    await store.set("other", { value: "3", contentType: "application/json", createdAt: Date.now() }, 30);
    expect(await store.deleteByPrefix("audit:event-cache:")).toBe(2);
    expect(await store.get("audit:event-cache:a")).toBeNull();
    expect(await store.get("other")).not.toBeNull();
    await store.delete("other");
    expect(await store.get("other")).toBeNull();
  });
});

describe("RedisCacheStore", () => {
  it("round-trips JSON entries", async () => {
    const backend = fakeBackend();
    const store = new RedisCacheStore(backend as never);
    await store.set("k", { value: "{\"a\":1}", contentType: "application/json", createdAt: Date.now() }, 30);
    expect(backend.data.has("k")).toBe(true);
    expect((await store.get("k"))?.value).toBe("{\"a\":1}");
  });

  it("deletes by prefix via keys + del", async () => {
    const backend = fakeBackend();
    const store = new RedisCacheStore(backend as never);
    await store.set("audit:event-cache:a", { value: "1", contentType: "application/json", createdAt: Date.now() }, 30);
    await store.set("audit:event-cache:b", { value: "2", contentType: "application/json", createdAt: Date.now() }, 30);
    expect(await store.deleteByPrefix("audit:event-cache:")).toBe(2);
    expect(await store.get("audit:event-cache:a")).toBeNull();
  });

  it("reports health from the backend", async () => {
    const backend = fakeBackend();
    const store = new RedisCacheStore(backend as never);
    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(store.name).toContain("redis");
  });
});

describe("MemcachedCacheStore", () => {
  it("stores and retrieves entries with TTL", async () => {
    const client = {
      async get(key: string) {
        return clientEntries.get(key) ?? null;
      },
      async set(key: string, value: string, _lifetime: number) {
        clientEntries.set(key, value);
      },
      async del(key: string) {
        clientEntries.delete(key);
      },
      async flush() {
        clientEntries.clear();
      },
    };
    const clientEntries = new Map<string, string>();
    const store = new MemcachedCacheStore(client as never);
    await store.set("k", { value: "392", contentType: "application/json", createdAt: Date.now() }, 30);
    expect((await store.get("k"))?.value).toBe("392");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });

  it("reports zero for prefix deletion (no server-side support)", async () => {
    const store = new MemcachedCacheStore({
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      flush: async () => undefined,
    } as never);
    expect(await store.deleteByPrefix("anything")).toBe(0);
  });
});

describe("createCacheStore", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("defaults to in-memory", () => {
    delete process.env.CACHE_BACKEND;
    expect(createCacheStore().name).toBe("memory");
  });

  it("honours an explicit backend", () => {
    process.env.CACHE_BACKEND = "MEMCACHED";
    expect(createCacheStore().name).toBe("memcached");
    process.env.CACHE_BACKEND = "redis";
    process.env.REDIS_URL = "redis://cache:6379";
    expect(createCacheStore().name).toBe("redis://cache:6379");
  });

  it("falls back to memory for an unknown backend", () => {
    process.env.CACHE_BACKEND = "couchbase";
    expect(createCacheStore().name).toBe("memory");
  });
});

describe("defaultCacheTtlSeconds", () => {
  it("falls back to 30 when unset or invalid", () => {
    delete process.env.CACHE_TTL_SECONDS;
    expect(defaultCacheTtlSeconds()).toBe(30);
    process.env.CACHE_TTL_SECONDS = "nope";
    expect(defaultCacheTtlSeconds()).toBe(30);
  });

  it("reads a configured TTL", () => {
    process.env.CACHE_TTL_SECONDS = "120";
    expect(defaultCacheTtlSeconds()).toBe(120);
  });
});

describe("cache middleware", () => {
  it("serves a MISS then a HIT for the same event query", async () => {
    const app = minApp(new MemoryCacheStore());
    const first = await request(app).get("/v1/stats");
    expect(first.headers["x-cache-status"]).toBe("MISS");
    expect(first.headers["cache-control"]).toMatch(/max-age=10/);
    expect(first.body.data.totalEvents).toBe(7);

    const second = await request(app).get("/v1/stats");
    expect(second.headers["x-cache-status"]).toBe("HIT");
    expect(second.body.data.totalEvents).toBe(7);
  });

  it("does not cache non-GET or unmatched routes", async () => {
    const app = minApp(new MemoryCacheStore());
    const res = await request(app).get("/v1/unknown");
    expect(res.headers["x-cache-status"]).toBeUndefined();
    const post = await request(app).post("/v1/stats");
    expect(post.headers["x-cache-status"]).toBeUndefined();
  });

  it("keys responses by the full URL incl. query string", async () => {
    const app = minApp(new MemoryCacheStore());
    await request(app).get("/v1/events?limit=5");
    await request(app).get("/v1/events?limit=5");
    const other = await request(app).get("/v1/events?limit=9");
    expect(other.headers["x-cache-status"]).toBe("MISS");
  });
});

describe("warmEventCache and invalidateEventCache", () => {
  it("pre-warms entries so the first request is a HIT", async () => {
    const store = new MemoryCacheStore();
    const app = minApp(store);

    await warmEventCache(store, [
      { key: "/v1/stats", value: JSON.stringify({ data: { totalEvents: 99 } }) },
    ]);

    const res = await request(app).get("/v1/stats");
    expect(res.headers["x-cache-status"]).toBe("HIT");
    expect(res.body.data.totalEvents).toBe(99);
  });

  it("invalidates every entry under the event-cache prefix", async () => {
    const store = new MemoryCacheStore();
    const app = minApp(store);
    await request(app).get("/v1/stats");
    const removed = await invalidateEventCache(store);
    expect(removed).toBeGreaterThan(0);
    const res = await request(app).get("/v1/stats");
    expect(res.headers["x-cache-status"]).toBe("MISS");
  });
});