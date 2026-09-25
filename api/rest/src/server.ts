import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import { resolvers } from "../../graphql/src/resolvers";
import {
  export_events,
  exportCsv,
  exportJson,
  createStreamingExporter,
  ExportOptions,
  ExportFilter,
} from "./export";
import { validateKey, generateKey, revokeKey, listKeys, type Role } from "./keys";
import { decodeCursor, encodeCursor, setPaginationHeaders } from "./pagination";
import {
  securityHeaders,
  cspMiddleware,
  ViolationReportStore,
  createViolationReportHandler,
  ddosProtection,
  wafAdminRouter,
  createRateLimiter,
  authenticateBearer,
  requireScopes,
  requireRole,
  type Algorithm,
} from "@audit-ledger/security";
import { authorizationServer, OAUTH_ISSUER, wafRuleEngine, createConfiguredRateLimitStore } from "./security";
import { createComplianceRouter } from "./compliance";
import { EventFilterSchema, EventTypeParamSchema, IndexParamSchema, PaginationSchema } from "./validation";

const app = express();
const port = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// ── Security headers + CSP (nonces, report-only mode, violation reporting) ─

app.use(securityHeaders());
app.use(
  cspMiddleware({
    reportOnly: process.env.CSP_REPORT_ONLY === "true",
    reportUri: "/csp-report",
    reportToGroup: "csp-endpoint",
  })
);

const cspViolationStore = new ViolationReportStore();
app.post(
  "/csp-report",
  express.json({ type: ["application/json", "application/csp-report", "application/reports+json"] }),
  createViolationReportHandler(cspViolationStore)
);

// ── DDoS protection / WAF (rule engine, bot detection, Cloudflare/AWS Shield) ─

app.use(
  ddosProtection({
    ruleEngine: wafRuleEngine,
    trustCloudflare: process.env.TRUST_CLOUDFLARE === "true",
    trustAwsWaf: process.env.TRUST_AWS_WAF === "true",
  })
);

// ── Distributed rate limiting (token bucket / sliding window / adaptive) ───

const rateLimitStore = createConfiguredRateLimitStore();
const rateLimitAlgorithm = (process.env.RATE_LIMIT_ALGORITHM ?? "token-bucket") as Algorithm;
const rateLimitCapacity = parseInt(process.env.RATE_LIMIT_MAX_TOKENS ?? "100", 10);
const rateLimitRefillRate = parseInt(process.env.RATE_LIMIT_REFILL_RATE ?? "10", 10);
const rateLimitIntervalMs = parseInt(process.env.RATE_LIMIT_REFILL_INTERVAL_MS ?? "60000", 10);

app.use(
  createRateLimiter({
    store: rateLimitStore,
    algorithm: rateLimitAlgorithm,
    tokenBucket: { capacity: rateLimitCapacity, refillTokens: rateLimitRefillRate, refillIntervalMs: rateLimitIntervalMs },
    slidingWindow: { limit: rateLimitCapacity, windowMs: rateLimitIntervalMs },
    adaptive: {
      baseCapacity: rateLimitCapacity,
      minCapacity: parseInt(process.env.RATE_LIMIT_MIN_TOKENS ?? "10", 10),
      refillTokens: rateLimitRefillRate,
      refillIntervalMs: rateLimitIntervalMs,
      errorWindowMs: 30_000,
      errorRateThreshold: 0.2,
    },
  })
);

// ── OAuth2 / OIDC ────────────────────────────────────────────────────────────
// Mounts /oauth/{authorize,token,jwks.json,introspect,revoke} and the
// discovery documents. See src/security.ts for client registration and for
// how to point at an external IdP instead via OIDC_JWKS_URI.

app.use("/oauth", authorizationServer.router());

const bearerAuth = authenticateBearer({ issuer: OAUTH_ISSUER, localIssuer: authorizationServer });

const v1Admin = express.Router();
v1Admin.use(bearerAuth);

v1Admin.get("/keys", requireScopes(["admin:keys"]), requireRole("admin"), (_req, res) => {
  res.json({
    data: listKeys().map((record) => ({ ...record, key: `${record.key.slice(0, 8)}…` })),
  });
});
v1Admin.post("/keys", requireScopes(["admin:keys"]), requireRole("admin"), (req, res) => {
  const { name, role } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  res.status(201).json({ data: generateKey(name, role) });
});
v1Admin.delete("/keys/:key", requireScopes(["admin:keys"]), requireRole("admin"), (req, res) => {
  if (!revokeKey(req.params.key)) return res.status(404).json({ error: "key not found" });
  res.status(204).end();
});
v1Admin.use("/waf", requireScopes(["admin:waf"]), requireRole("admin"), wafAdminRouter(wafRuleEngine));

app.use("/v1/admin", v1Admin);
app.use("/v1", createComplianceRouter());

function resolveContext(req: express.Request): { apiKey?: string; role?: Role } {
  const apiKey = (req.headers["x-api-key"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
  if (!apiKey) return {};
  const record = validateKey(apiKey);
  return record ? { apiKey, role: record.role } : {};
}

function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function problem(res: express.Response, status: number, title: string, detail: string, type = "about:blank") {
  return res.status(status).type("application/problem+json").json({ type, title, status, detail });
}

function parseEventFilter(req: express.Request): { value: Record<string, unknown> | null } | { error: string } {
  const query = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const key of ["type", "submitter", "metadata", "startTime", "endTime"] as const) {
    if (query[key] !== undefined) filter[key] = query[key];
  }
  const raw = query.filter ?? (Object.keys(filter).length ? filter : undefined);
  if (raw === undefined) return { value: null };
  const candidate = typeof raw === "string"
    ? raw
    : JSON.stringify({
        ...(typeof raw === "object" ? raw : {}),
        ...filter,
        ...(filter.startTime !== undefined ? { startTime: Number(filter.startTime) } : {}),
        ...(filter.endTime !== undefined ? { endTime: Number(filter.endTime) } : {}),
      });
  const parsed = EventFilterSchema.safeParse(candidate);
  return parsed.success ? { value: parsed.data as Record<string, unknown> | null } : { error: parsed.error.issues[0]?.message ?? "invalid filter" };
}

// ── Health Check Endpoints (#268) ─────────────────────────────────────────────

const startTime = Date.now();

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get("/readyz", (_req, res) => {
  const checks: Record<string, { status: string; latencyMs?: number }> = {};

  const storeCheckStart = Date.now();
  try {
    resolvers.Query.statistics(null, {}, null);
    checks.eventStore = { status: "ok", latencyMs: Date.now() - storeCheckStart };
  } catch {
    checks.eventStore = { status: "failed", latencyMs: Date.now() - storeCheckStart };
  }

  const allHealthy = Object.values(checks).every((c) => c.status === "ok");
  const statusCode = allHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: allHealthy ? "ready" : "not_ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", (_req, res) => {
  const stats = resolvers.Query.statistics(null, {}, null) as Record<string, unknown>;
  const byType = (stats.eventsByType as Record<string, number>) ?? {};
  const lines = [
    "# HELP audit_ledger_events_total Total number of audit events",
    "# TYPE audit_ledger_events_total counter",
    `audit_ledger_events_total ${stats.totalEvents ?? 0}`,
    "",
    "# HELP audit_ledger_events_by_type Events count by type",
    "# TYPE audit_ledger_events_by_type gauge",
    ...Object.entries(byType).map(([t, c]) => `audit_ledger_events_by_type{event_type="${t}"} ${c}`),
    "",
    "# HELP audit_ledger_uptime_seconds API uptime in seconds",
    "# TYPE audit_ledger_uptime_seconds gauge",
    `audit_ledger_uptime_seconds ${Math.floor((Date.now() - startTime) / 1000)}`,
  ];
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n"));
});

// ── Version Middleware (#271) ─────────────────────────────────────────────────

const SUPPORTED_VERSIONS = ["v1"];
const DEPRECATED_VERSIONS: Record<string, string> = {};
const LATEST_VERSION = "v1";

app.use((req, res, next) => {
  res.setHeader("X-API-Version", LATEST_VERSION);
  res.setHeader("X-Supported-Versions", SUPPORTED_VERSIONS.join(", "));

  const versionHeader = req.headers["accept-version"] as string | undefined;
  const urlMatch = req.path.match(/^\/(v\d+)\//);

  let requestedVersion = versionHeader ?? urlMatch?.[1] ?? LATEST_VERSION;

  if (DEPRECATED_VERSIONS[requestedVersion]) {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", DEPRECATED_VERSIONS[requestedVersion]);
    res.setHeader("X-Deprecation-Notice", `API version ${requestedVersion} is deprecated. Use ${LATEST_VERSION}.`);
  }

  (req as express.Request & { apiVersion?: string }).apiVersion = requestedVersion;
  next();
});

// ── Versioned Routes (#271) ───────────────────────────────────────────────────

const v1 = express.Router();

// GET /events - List all events with pagination
v1.get("/events", (req, res) => {
  const pagination = PaginationSchema.safeParse({ limit: req.query.limit, offset: req.query.cursor ? undefined : req.query.offset });
  if (!pagination.success) return problem(res, 400, "Invalid pagination", pagination.error.issues[0]?.message ?? "limit or offset is invalid");
  const limit = pagination.data.limit;
  const parsedFilter = parseEventFilter(req);
  if ("error" in parsedFilter) return problem(res, 400, "Invalid filter", parsedFilter.error);
  const filter = parsedFilter.value;

  let offset = pagination.data.offset;
  if (req.query.cursor) {
    const decoded = decodeCursor(req.query.cursor as string);
    if (!decoded) {
      return problem(res, 400, "Invalid cursor", "cursor is malformed or unsupported");
    }
    offset = decoded.index;
  }

  const allFiltered = resolvers.Query.events(null, { limit: 100000, offset: 0, filter });
  const total = allFiltered.length;
  const result = allFiltered.slice(offset, offset + limit);

  const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : null;
  const prevCursor = offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null;

  setPaginationHeaders(res, "/events", total, limit, offset, nextCursor, prevCursor);
  res.json({ data: result });
});

// GET /events/:index - Get event by index
v1.get("/events/:index", (req, res) => {
  const parsedIndex = IndexParamSchema.safeParse({ index: req.params.index });
  if (!parsedIndex.success) return problem(res, 400, "Invalid index", "index must be a non-negative integer");
  const index = parsedIndex.data.index;

  const ctx = resolveContext(req);
  const result = resolvers.Query.event(null, { index }, ctx);

    if (!result) {
      return problem(res, 404, "Event not found", `event with index ${index} was not found`);
    }
    res.json({ data: result });
  }
);

// GET /events/type/:type - Get events by type with pagination
v1.get("/events/type/:type", (req, res) => {
  const parsedType = EventTypeParamSchema.safeParse({ type: req.params.type });
  const pagination = PaginationSchema.safeParse({ limit: req.query.limit, offset: req.query.cursor ? undefined : req.query.offset });
  if (!parsedType.success) return problem(res, 400, "Invalid event type", parsedType.error.issues[0]?.message ?? "type is invalid");
  if (!pagination.success) return problem(res, 400, "Invalid pagination", pagination.error.issues[0]?.message ?? "limit or offset is invalid");
  const type = parsedType.data.type;
  const limit = pagination.data.limit;
  let offset = pagination.data.offset;
  if (req.query.cursor) {
    const decoded = decodeCursor(req.query.cursor as string);
    if (!decoded) return problem(res, 400, "Invalid cursor", "cursor is malformed or unsupported");
    offset = decoded.index;
  }

  const ctx = resolveContext(req);
  const allByType = Array.from({ length: 1000 }, (_, i) => i)
    .map((typeIndex) => resolvers.Query.eventByType(null, { type, typeIndex }, ctx))
    .filter(Boolean);

  const total = allByType.length;
  const result = allByType.slice(offset, offset + limit);

  const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : null;
  const prevCursor = offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null;

  setPaginationHeaders(res, `/events/type/${type}`, total, limit, offset, nextCursor, prevCursor);
  res.json({ data: result });
});

// GET /stats - Get statistics
v1.get("/stats", (req, res) => {
  const ctx = resolveContext(req);
  const result = resolvers.Query.statistics(null, {}, ctx);
  res.json({ data: result });
});

// ── Export Endpoints (#201) ───────────────────────────────────────────────────

/**
 * Parse export filter from query params.
 * Supports: startTime, endTime (epoch seconds), type, submitter, and a
 * legacy JSON `filter` param for backwards compatibility.
 */
function parseExportFilter(query: Record<string, unknown>): ExportFilter {
  const filter: ExportFilter = {};

  if (query.filter) {
    try {
      const parsed = JSON.parse(query.filter as string) as ExportFilter;
      Object.assign(filter, parsed);
    } catch {
      // ignore malformed legacy filter
    }
  }

  if (query.startTime) {
    const v = parseInt(query.startTime as string, 10);
    if (!isNaN(v)) filter.startTime = v;
  }
  if (query.endTime) {
    const v = parseInt(query.endTime as string, 10);
    if (!isNaN(v)) filter.endTime = v;
  }
  if (query.type) filter.type = query.type as string;
  if (query.submitter) filter.submitter = query.submitter as string;

  return filter;
}

// GET /export/events.json - JSON export with time range + integrity proof
v1.get("/export/events.json", (req, res) => {
  const options: ExportOptions = {
    format: "json",
    filter: parseExportFilter(req.query as Record<string, unknown>),
    limit: parseInt(req.query.limit as string) || undefined,
    offset: parseInt(req.query.offset as string) || undefined,
    fields: req.query.fields ? (req.query.fields as string).split(",") : undefined,
    includeProof: req.query.proof !== "false",
  };

  const result = exportJson(options);
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.setHeader("Content-Type", result.contentType);
  if (result.proof) {
    res.setHeader("X-Export-Event-Count", String(result.proof.eventCount));
    res.setHeader("X-Export-Hash", result.proof.exportHash);
  }
  res.json(JSON.parse(result.data));
});

// GET /export/events.csv - CSV export with time range + integrity proof
v1.get("/export/events.csv", (req, res) => {
  const options: ExportOptions = {
    format: "csv",
    filter: parseExportFilter(req.query as Record<string, unknown>),
    limit: parseInt(req.query.limit as string) || undefined,
    offset: parseInt(req.query.offset as string) || undefined,
    fields: req.query.fields ? (req.query.fields as string).split(",") : undefined,
    includeProof: req.query.proof !== "false",
  };

  const result = exportCsv(options);
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.setHeader("Content-Type", result.contentType);
  if (result.proof) {
    res.setHeader("X-Export-Event-Count", String(result.proof.eventCount));
    res.setHeader("X-Export-Hash", result.proof.exportHash);
  }
  res.send(result.data);
});

// GET /export/events/stream - Streaming export for large datasets (#201)
v1.get("/export/events/stream", async (req, res) => {
  const fmt = (req.query.format as string) === "csv" ? "csv" : "json";
  const options: ExportOptions = {
    format: fmt,
    filter: parseExportFilter(req.query as Record<string, unknown>),
    limit: parseInt(req.query.limit as string) || undefined,
    offset: parseInt(req.query.offset as string) || undefined,
    fields: req.query.fields ? (req.query.fields as string).split(",") : undefined,
    stream: true,
    includeProof: req.query.proof !== "false",
  };

  const exporter = createStreamingExporter(options);
  const contentType =
    fmt === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Export-Status", "running");

  try {
    for await (const chunk of exporter.generate()) {
      res.write(chunk);
    }
    res.setHeader("X-Export-Status", "completed");
    res.setHeader("X-Export-Event-Count", String(exporter.progress.exported));
    res.end();
  } catch (err) {
    res.setHeader("X-Export-Status", "failed");
    res.setHeader("X-Export-Error", err instanceof Error ? err.message : String(err));
    res.end();
  }
});

// GET /export/progress - Status info for streaming exports (#201)
v1.get("/export/progress", (_req, res) => {
  res.json({
    status: "idle",
    message:
      "Use export endpoints to start an export. Progress is tracked via X-Export-Status and X-Export-Event-Count response headers for streaming exports.",
  });
});

app.use("/v1", v1);

// Legacy unversioned routes (redirect to v1)
app.get("/events", (req, res) => {
  res.redirect(301, `/v1/events${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`);
});
app.get("/events/:index", (req, res) => {
  res.redirect(301, `/v1/events/${req.params.index}`);
});
app.get("/events/type/:type", (req, res) => {
  res.redirect(301, `/v1/events/type/${req.params.type}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`);
});
app.get("/stats", (_req, res) => {
  res.redirect(301, "/v1/stats");
});

// Consistent JSON errors for malformed requests and unexpected failures.
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    return problem(res, 400, "Malformed JSON", "request body must contain valid JSON");
  }
  console.error("Unhandled REST error", error);
  return problem(res, 500, "Internal Server Error", "an unexpected error occurred");
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`REST API listening on port ${port}`);
    console.log(`  Versioned: /v1/*`);
    console.log(`  Legacy:    /events, /stats (301 → /v1/...)`);
    console.log(`  Health:    /healthz, /readyz, /metrics`);
    console.log(`  Export:    /v1/export/events.{json,csv}, /v1/export/events/stream`);
    console.log(`  OAuth2:    /oauth/{authorize,token,jwks.json}, /.well-known/openid-configuration`);
    console.log(`  Admin:     /v1/admin/{keys,waf} (requires admin role + scope)`);
  });
}

export { app };
