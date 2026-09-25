import { Request, Response, NextFunction } from "express";
import { tokenBucketConsume, type RateLimitStore, type TokenBucketConfig } from "@audit-ledger/security";
import { validateKey } from "./keys";

/**
 * Per-client quota enforcement with token-bucket burst handling (#444).
 *
 * The shared `@audit-ledger/security` rate limiter protects the API globally
 * (and its store can be a Redis Cluster for distributed coordination). This
 * layer adds per-client quotas on top: each request is classified into a
 * quota tier (explicit header, API-key role, or `default`) and consumes from
 * its own token bucket inside the same shared store.
 *
 * Burst handling: the bucket capacity is `capacity * burstMultiplier` while
 * tokens refill at the steady `capacity` per `refillIntervalMs`, so clients
 * can short-burst above their sustained quota without ever exceeding the
 * bounded steady-state rate.
 *
 * Quotas come from `RATE_LIMIT_QUOTAS_JSON` (partial, merged over the
 * built-in defaults):
 *
 *   {"admin":{"capacity":2000,"burstMultiplier":3},"viewer":{"capacity":50}}
 */

export interface ClientQuota {
  /** Steady-state requests allowed per refillIntervalMs. */
  capacity: number;
  refillIntervalMs: number;
  /** Burst capacity = capacity * burstMultiplier (>= 1). */
  burstMultiplier: number;
}

export function defaultQuotas(): Record<string, ClientQuota> {
  const refillIntervalMs = 60_000;
  return {
    default: { capacity: 100, refillIntervalMs, burstMultiplier: 2 },
    viewer: { capacity: 50, refillIntervalMs, burstMultiplier: 2 },
    auditor: { capacity: 200, refillIntervalMs, burstMultiplier: 2 },
    admin: { capacity: 1_000, refillIntervalMs, burstMultiplier: 3 },
  };
}

export function quotasFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, ClientQuota> {
  const raw = env.RATE_LIMIT_QUOTAS_JSON;
  if (!raw) return defaultQuotas();
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ClientQuota>>;
    const quotas = defaultQuotas();
    for (const [tier, override] of Object.entries(parsed)) {
      const base = quotas[tier] ?? defaultQuotas().default;
      quotas[tier] = {
        capacity: override.capacity ?? base.capacity,
        refillIntervalMs: override.refillIntervalMs ?? base.refillIntervalMs,
        burstMultiplier: override.burstMultiplier ?? base.burstMultiplier,
      };
    }
    return quotas;
  } catch {
    return defaultQuotas();
  }
}

function apiKeyOf(req: Request): string | undefined {
  const key = req.headers["x-api-key"] as string | undefined;
  if (key) return key.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

function clientKeyFor(req: Request): string {
  const apiKey = apiKeyOf(req);
  if (apiKey) return `key:${apiKey}`;
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
    ?? req.ip
    ?? "unknown";
  return `ip:${ip}`;
}

function resolveTier(req: Request, quotas: Record<string, ClientQuota>): string {
  const explicit = req.headers["x-quota-tier"] as string | undefined;
  if (explicit && quotas[explicit]) return explicit;

  const apiKey = apiKeyOf(req);
  if (apiKey) {
    const record = validateKey(apiKey);
    if (record && quotas[record.role]) return record.role;
  }
  return "default";
}

export interface ClientQuotaOptions {
  quotas?: Record<string, ClientQuota>;
  /** Injectable clock for deterministic burst tests. */
  now?: () => number;
}

export function createClientQuotaMiddleware(
  store: RateLimitStore,
  options: ClientQuotaOptions = {}
) {
  const quotas = options.quotas ?? quotasFromEnv();
  const nowFn = options.now ?? Date.now;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const now = nowFn();
    const tier = resolveTier(req, quotas);
    const quota = quotas[tier] ?? quotas.default ?? defaultQuotas().default;

    const burstCapacity = Math.max(
      quota.capacity,
      Math.round(quota.capacity * quota.burstMultiplier)
    );
    const bucket: TokenBucketConfig = {
      capacity: burstCapacity,
      refillTokens: quota.capacity,
      refillIntervalMs: quota.refillIntervalMs,
    };

    try {
      const result = await tokenBucketConsume(
        store,
        `quota:${tier}:${clientKeyFor(req)}`,
        1,
        bucket,
        now
      );

      res.setHeader("RateLimit-Limit", String(quota.capacity));
      res.setHeader("RateLimit-Remaining", String(result.remaining));
      res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));
      // Legacy headers kept for existing clients in this codebase.
      res.setHeader("X-RateLimit-Limit", String(quota.capacity));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));
      res.setHeader("X-Quota-Tier", tier);

      if (!result.allowed) {
        const retryAfterSeconds = Math.ceil(result.resetMs / 1000);
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({
          error: "quota_exceeded",
          tier,
          quotaCapacity: quota.capacity,
          burstCapacity,
          retryAfterMs: result.resetMs,
        });
        return;
      }

      next();
    } catch (err) {
      next(err as Error);
    }
  };
}