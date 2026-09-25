import { Request, Response, NextFunction } from "express";

/**
 * API versioning with deprecation (#445).
 *
 * Requests may select a version via the URL (`/vN/...`) or a request header
 * (`Accept-Version` / `X-API-Version`). The latest active version is the
 * default, and every response carries `X-API-Version` + `X-Supported-Versions`.
 *
 * Versions follow an explicit deprecation schedule: a `deprecatedAt` marks the
 * start of deprecation (RFC 8594 `Deprecation` + `Sunset` headers, plus a
 * `Link` rel="successor-version"), and once `sunsetAt` passes the version is
 * served as `410 Gone`. Multiple versions run concurrently (see the `/versions`
 * discovery endpoint and the migration guide in docs/api-versioning.md).
 */

export type ApiVersionStatus = "active" | "deprecated" | "sunset";

export interface ApiVersionInfo {
  version: string;
  status: ApiVersionStatus;
  mountPath: string;
  releasedAt?: string;
  deprecatedAt?: string;
  sunsetAt?: string;
  successor?: string;
}

export interface VersionRegistry {
  latest: string;
  versions: ApiVersionInfo[];
}

export class UnsupportedVersionError extends Error {
  readonly requested: string;
  readonly supported: string[];
  constructor(requested: string, supported: string[]) {
    super(`Unsupported API version: ${requested}`);
    this.name = "UnsupportedVersionError";
    this.requested = requested;
    this.supported = supported;
  }
}

function isoDate(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toUTCString();
}

export function defaultVersionRegistry(): VersionRegistry {
  return {
    latest: "v1",
    versions: [
      {
        version: "v0",
        status: "deprecated",
        mountPath: "/v0",
        releasedAt: "2023-01-01",
        deprecatedAt: "2025-01-01",
        sunsetAt: "2027-01-01",
        successor: "v1",
      },
      {
        version: "v1",
        status: "active",
        mountPath: "/v1",
        releasedAt: "2024-07-01",
      },
    ],
  };
}

export function versionRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback: VersionRegistry = defaultVersionRegistry()
): VersionRegistry {
  const raw = env.API_VERSION_REGISTRY_JSON;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as VersionRegistry;
    if (!parsed.latest || !Array.isArray(parsed.versions) || parsed.versions.length === 0) {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function findVersion(registry: VersionRegistry, version: string): ApiVersionInfo | undefined {
  return registry.versions.find((v) => v.version === version);
}

export interface NegotiatedVersion {
  info: ApiVersionInfo;
  source: "url" | "header" | "default";
}

/**
 * Resolves the requested version from header or URL, defaulting to the latest
 * active version. Throws `UnsupportedVersionError` when a version is explicitly
 * requested but not registered (an implicit `/vM/...` URL that matches nothing
 * later 404s via the router).
 */
export function negotiateVersion(
  req: Request,
  registry: VersionRegistry,
  now: Date = new Date()
): NegotiatedVersion {
  const header = (req.headers["accept-version"] ?? req.headers["x-api-version"]) as string | undefined;
  const urlMatch = req.path.match(/^\/(v\d+)\//);

  const requested = header?.trim() || urlMatch?.[1] || registry.latest;
  const source: NegotiatedVersion["source"] = header ? "header" : urlMatch ? "url" : "default";

  const info = findVersion(registry, requested);
  if (!info) {
    throw new UnsupportedVersionError(
      requested,
      registry.versions.map((v) => v.version)
    );
  }

  const sunset = info.sunsetAt ? new Date(info.sunsetAt) : null;
  const effectiveStatus: ApiVersionStatus =
    sunset && sunset <= now ? "sunset" : info.status;

  return { info: { ...info, status: effectiveStatus }, source };
}

/** Attaches the versioning response headers for the resolved version. */
export function setApiVersionHeaders(
  res: Response,
  info: ApiVersionInfo,
  registry: VersionRegistry
): void {
  res.setHeader("X-API-Version", info.version);
  res.setHeader("X-Supported-Versions", registry.versions.map((v) => v.version).join(", "));

  if (info.status === "deprecated" || info.status === "sunset") {
    res.setHeader("Deprecation", "true");
    if (info.sunsetAt) res.setHeader("Sunset", isoDate(info.sunsetAt));
    if (info.successor) {
      const successor = findVersion(registry, info.successor);
      res.setHeader(
        "Link",
        `<${successor?.mountPath ?? "/"}${successor ? "/" : ""}>; rel="successor-version"; title="${info.successor}"`
      );
    }
  }
}

export interface VersioningOptions {
  registry?: VersionRegistry;
  now?: () => Date;
  migrationGuideUrl?: string;
}

/** Express middleware enforcing header + URL version negotiation, deprecation
 * headers, and sunset enforcement. */
export function createVersioningMiddleware(options: VersioningOptions = {}) {
  const registry = options.registry ?? versionRegistryFromEnv();
  const nowFn = options.now ?? (() => new Date());

  return (req: Request, res: Response, next: NextFunction): void => {
    let negotiated: NegotiatedVersion;
    try {
      negotiated = negotiateVersion(req, registry, nowFn());
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        res.status(404).json({
          error: {
            code: "UNSUPPORTED_API_VERSION",
            message: `Unsupported API version: ${err.requested}. Supported: ${err.supported.join(", ")}.`,
            requestedVersion: err.requested,
            supportedVersions: err.supported,
            latestVersion: registry.latest,
          },
        });
        return;
      }
      next(err as Error);
      return;
    }

    const { info } = negotiated;

    if (info.status === "sunset") {
      setApiVersionHeaders(res, info, registry);
      res.status(410).json({
        error: {
          code: "API_VERSION_SUNSET",
          message: `API version ${info.version} has been sunset (${info.sunsetAt ?? "no date"}). Migrate to ${info.successor ?? registry.latest}.`,
          migrationGuide: options.migrationGuideUrl,
        },
      });
      return;
    }

    setApiVersionHeaders(res, info, registry);
    (req as Request & { apiVersion?: string }).apiVersion = info.version;
    next();
  };
}

/** `GET /versions` — discovery of concurrent versions, statuses, and the
 * deprecation schedule. */
export function versionsHandler(
  registry: VersionRegistry = versionRegistryFromEnv(),
  migrationGuideUrl = "https://github.com/daddygokings-art/Decentralized-Audit-Transparency-Ledger/blob/master/docs/api-versioning.md"
) {
  return (_req: Request, res: Response): void => {
    const versions = registry.versions.map((v) => ({
      version: v.version,
      status: v.status,
      mountPath: v.mountPath,
      releasedAt: v.releasedAt ?? null,
      deprecatedAt: v.deprecatedAt ?? null,
      sunsetAt: v.sunsetAt ?? null,
      successor: v.successor ?? null,
    }));
    res.json({
      data: {
        latest: registry.latest,
        defaultMountedOn: "/",
        versions,
        migrationGuide: migrationGuideUrl,
      },
    });
  };
}