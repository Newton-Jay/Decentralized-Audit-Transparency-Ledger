import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { MemoryRateLimitStore } from "@audit-ledger/security";
import {
  createClientQuotaMiddleware,
  defaultQuotas,
  quotasFromEnv,
  ClientQuota,
} from "../src/clientQuota";
import { generateKey } from "../src/keys";

function appFor(clock: () => number, quotas?: Record<string, ClientQuota>) {
  const store = new MemoryRateLimitStore();
  const app = express();
  app.use(express.json());
  app.use("/v1", createClientQuotaMiddleware(store, { quotas, now: clock }));
  app.get("/v1/events", (_req, res) => res.json({ data: [] }));
  return app;
}

describe("per-client quotas", () => {
  it("applies the default tier and emits rate-limit headers", async () => {
    let now = 1_000_000;
    const app = appFor(() => now);
    const res = await request(app).get("/v1/events");
    expect(res.status).toBe(200);
    expect(res.headers["x-quota-tier"]).toBe("default");
    expect(res.headers["ratelimit-limit"]).toBe("100");
    expect(res.headers["ratelimit-remaining"]).toBe("199");
    expect(res.headers["x-ratelimit-limit"]).toBe("100");
  });

  it("returns 429 with Retry-After once the burst quota is exhausted", async () => {
    const now = 5_000_000;
    const quotas: Record<string, ClientQuota> = {
      default: { capacity: 3, refillIntervalMs: 60_000, burstMultiplier: 3 },
    };
    const app = appFor(() => now, quotas);

    let status = 200;
    for (let i = 0; i < 9; i++) {
      status = (await request(app).get("/v1/events")).status;
    }
    expect(status).toBe(200);

    const blocked = await request(app).get("/v1/events");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("quota_exceeded");
    expect(blocked.body.burstCapacity).toBe(9);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("refills steady-state tokens after a window elapses", async () => {
    let now = 10_000_000;
    const quotas: Record<string, ClientQuota> = {
      default: { capacity: 2, refillIntervalMs: 60_000, burstMultiplier: 4 },
    };
    const app = appFor(() => now, quotas);

    let last = 0;
    for (let i = 0; i < 8; i++) last = (await request(app).get("/v1/events")).status;
    expect((await request(app).get("/v1/events")).status).toBe(429);

    now += 60_000; // one full refill interval
    expect((await request(app).get("/v1/events")).status).toBe(200);
    expect((await request(app).get("/v1/events")).status).toBe(200);
    expect((await request(app).get("/v1/events")).status).toBe(429);
  });

  it("selects a tier via the x-quota-tier header", async () => {
    const app = appFor(() => 1_000_000);
    const res = await request(app)
      .get("/v1/events")
      .set("x-quota-tier", "admin");
    expect(res.headers["x-quota-tier"]).toBe("admin");
    expect(res.headers["ratelimit-limit"]).toBe("1000");
  });

  it("selects a tier from the API-key role", async () => {
    const app = appFor(() => 1_000_000);
    const record = generateKey("quota-test", "viewer");
    const res = await request(app)
      .get("/v1/events")
      .set("x-api-key", record.key);
    expect(res.headers["x-quota-tier"]).toBe("viewer");
    expect(res.headers["ratelimit-limit"]).toBe("50");
  });

  it("keeps separate buckets per client", async () => {
    const quotas: Record<string, ClientQuota> = {
      default: { capacity: 1, refillIntervalMs: 60_000, burstMultiplier: 1 },
      auditor: { capacity: 1, refillIntervalMs: 60_000, burstMultiplier: 1 },
    };
    const app = appFor(() => 1_000_000, quotas);

    expect((await request(app).get("/v1/events")).status).toBe(200);
    // A different tier is not affected by the exhausted default bucket.
    expect(
      (await request(app).get("/v1/events").set("x-quota-tier", "auditor")).status
    ).toBe(200);
    expect((await request(app).get("/v1/events")).status).toBe(429);
  });
});

describe("quotasFromEnv", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("merges a JSON override over the defaults", () => {
    process.env.RATE_LIMIT_QUOTAS_JSON = JSON.stringify({
      admin: { capacity: 5000 },
      viewer: { capacity: 25, refillIntervalMs: 30_000 },
    });
    const quotas = quotasFromEnv();
    expect(quotas.admin.capacity).toBe(5000);
    expect(quotas.admin.burstMultiplier).toBe(defaultQuotas().admin.burstMultiplier);
    expect(quotas.viewer.capacity).toBe(25);
    expect(quotas.viewer.refillIntervalMs).toBe(30_000);
  });

  it("falls back to defaults on malformed JSON", () => {
    process.env.RATE_LIMIT_QUOTAS_JSON = "{not json";
    expect(quotasFromEnv()).toEqual(defaultQuotas());
  });

  it("uses defaults when unset", () => {
    delete process.env.RATE_LIMIT_QUOTAS_JSON;
    expect(quotasFromEnv()).toEqual(defaultQuotas());
  });
});