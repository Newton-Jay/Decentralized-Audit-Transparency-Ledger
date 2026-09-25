# API Versioning & Deprecation

The AuditLedger REST API supports **multiple concurrent versions** so consumers
can upgrade on their own schedule. Requests select a version by URL or header;
old versions are deprecated with an explicit, dated sunset so there is never an
unexpected breaking change.

## Selecting a version

Two mechanisms are supported, checked in this order:

1. **URL versioning** — `GET /v1/events`, `GET /v0/stats`, etc. The `vN`
   prefix determines the version.
2. **Header versioning** — `Accept-Version: v1` (or `X-API-Version: v1`).
   A header overrides the URL prefix for a request.
3. **Default** — requests with no version marker use the latest active version.

Every response echoes the resolved version in `X-API-Version` and lists the
concurrently-supported versions in `X-Supported-Versions`.

Discover the current schedule at `GET /versions`.

## Deprecation schedule

A version's lifecycle is `active → deprecated → sunset`:

| Version | Status     | Released    | Deprecated  | Sunset       | Successor |
| ------- | ---------- | ----------- | ----------- | ------------ | --------- |
| v1      | active     | 2024-07-01  | —           | —            | —         |
| v0      | deprecated | 2023-01-01  | 2025-01-01  | 2027-01-01   | v1        |

* **Deprecated** — the version still serves traffic and works exactly as
  before, but responses carry `Deprecation: true` and `Sunset: <date>` headers
  (RFC 8594) plus a `Link: <next>; rel="successor-version"` header.
* **Sunset** — after the sunset date the version stops being served and
  requests receive `410 Gone` with the successor and this migration guide.

The schedule is data-driven: `API_VERSION_REGISTRY_JSON` overrides the built-in
registry (used by operators to set/advance dates without a code change).

## Migration guides

Moving between concurrent versions is a normal, low-risk operation:

1. Read the target version's reference at
   [`docs/api-reference.md`](api-reference.md) and compare to the one you use.
2. Point your client at the new version (`https://.../v1/events` or
   `Accept-Version: v1`) in a staging environment.
3. Remove/replace any fields the target version no longer accepts; deprecated
   versions do not change behavior during the deprecation window.
4. Before a version's sunset date, migrate the last instances and update the
   registry to mark it sunset.

New versions ship *alongside* old ones; nothing is removed until its sunset.