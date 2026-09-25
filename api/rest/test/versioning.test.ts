import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  createVersioningMiddleware,
  versionsHandler,
  defaultVersionRegistry,
  versionRegistryFromEnv,
  negotiateVersion,
  UnsupportedVersionError,
} from "../src/versioning";

function miniApp(now: () => Date, registry = defaultVersionRegistry()) {
  const app = express();
  app.use(
    createVersioningMiddleware({
      registry,
      now,
      migrationGuideUrl: "/docs/api-versioning.md",
    })
  );
  app.get("/versions", versionsHandler(registry));
  app.get("/v1/ping", (_req, res) => res.json({ ok: true, version: "v1" }));
  app.get("/v0/ping", (_req, res) => res.json({ ok: true, version: "v0" }));
  return app;
}

describe("version negotiation", () => {
  const registry = defaultVersionRegistry();

  it("defaults to the latest active version", () => {
    const req = { path: "/events", headers: {} } as never;
    const result = negotiateVersion(req as never, registry);
    expect(result.info.version).toBe("v1");
    expect(result.info.status).toBe("active");
    expect(result.source).toBe("default");
  });

  it("resolves from the URL prefix", () => {
    const result = negotiateVersion({ path: "/v0/stats", headers: {} } as never, registry);
    expect(result.info.version).toBe("v0");
    expect(result.info.status).toBe("deprecated");
    expect(result.source).toBe("url");
  });

  it("resolves from the Accept-Version header and overrides the URL", () => {
    const result = negotiateVersion(
      { path: "/v1/stats", headers: { "accept-version": "v0" } } as never,
      registry
    );
    expect(result.info.version).toBe("v0");
    expect(result.source).toBe("header");
  });

  it("rejects an unregistered version", () => {
    expect(() =>
      negotiateVersion({ path: "/events", headers: { "x-api-version": "v9" } } as never, registry)
    ).toThrow(UnsupportedVersionError);
  });
});

describe("versioning middleware over HTTP", () => {
  it("serves the default version with version headers", async () => {
    const app = miniApp(() => new Date("2026-09-24T00:00:00Z"));
    const res = await request(app).get("/v1/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-api-version"]).toBe("v1");
    expect(res.headers["x-supported-versions"]).toBe("v0, v1");
    expect(res.headers["deprecation"]).toBeUndefined();
  });

  it("marks deprecated responses with Deprecation/Sunset/successor headers", async () => {
    const app = miniApp(() => new Date("2026-09-24T00:00:00Z"));
    const res = await request(app).get("/v0/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-api-version"]).toBe("v0");
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["sunset"]).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(res.headers["link"]).toContain("successor-version");
  });

  it("returns a structured 404 for an unsupported header version", async () => {
    const app = miniApp(() => new Date("2026-09-24T00:00:00Z"));
    const res = await request(app).get("/v1/ping").set("Accept-Version", "v9");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("UNSUPPORTED_API_VERSION");
    expect(res.body.error.supportedVersions).toEqual(["v0", "v1"]);
  });

  it("returns 410 Gone once a version is past its sunset", async () => {
    const registry = defaultVersionRegistry();
    registry.versions[0].sunsetAt = "2026-01-01"; // v0 sunset in the past
    const app = miniApp(() => new Date("2026-09-24T00:00:00Z"), registry);

    const byUrl = await request(app).get("/v0/ping");
    expect(byUrl.status).toBe(410);
    expect(byUrl.body.error.code).toBe("API_VERSION_SUNSET");

    const byHeader = await request(app).get("/v1/ping").set("Accept-Version", "v0");
    expect(byHeader.status).toBe(410);
    expect(byHeader.body.error.migrationGuide).toMatch(/api-versioning\.md/);
  });

  it("exposes the version registry and schedule via /versions", async () => {
    const app = miniApp(() => new Date("2026-09-24T00:00:00Z"));
    const res = await request(app).get("/versions");
    expect(res.status).toBe(200);
    expect(res.body.data.latest).toBe("v1");
    const v0 = res.body.data.versions.find((v: { version: string }) => v.version === "v0");
    expect(v0.status).toBe("deprecated");
    expect(v0.successor).toBe("v1");
    expect(res.body.data.migrationGuide).toMatch(/api-versioning\.md/);
  });
});

describe("versionRegistryFromEnv", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("falls back to defaults when unset or malformed", () => {
    delete process.env.API_VERSION_REGISTRY_JSON;
    expect(versionRegistryFromEnv()).toEqual(defaultVersionRegistry());
    process.env.API_VERSION_REGISTRY_JSON = "{nope";
    expect(versionRegistryFromEnv()).toEqual(defaultVersionRegistry());
  });

  it("applies a registry override", () => {
    process.env.API_VERSION_REGISTRY_JSON = JSON.stringify({
      latest: "v2",
      versions: [{ version: "v2", status: "active", mountPath: "/v2" }],
    });
    const reg = versionRegistryFromEnv();
    expect(reg.latest).toBe("v2");
    expect(reg.versions).toHaveLength(1);
  });
});