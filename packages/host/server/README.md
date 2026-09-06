---
description: "The /mu/v1/* control-plane HTTP surface for the multi-tenant DeepSeek Harness host: lookup / ensure / token:issue / health, mounted on top of dsh-host-webserver with a Bearer-token machine-channel middleware."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-server

English | [中文](README.zh.md)

## Summary

`dsh-host-server` is the orchestrator plugin that wires four sibling packages into one HTTP surface: the `dsh-host-webserver` transport, the `dsh-host-lookup` reverse-lookup orchestrator, the `dsh-host-auth` EdDSA JWT issuer, and the `dsh-storage-postgres` multi-tenant row store. Its only responsibility is to register six routes on top of `webServer.register()` and to enforce a single shared machine API key in front of every write/read surface except `/health`. The package owns no business logic — that lives in the four siblings.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Route surface](#route-surface)
- [Configuration](#configuration)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## Use this package

Compose this plugin after the four siblings. The plugin's `inject` field enforces the ordering: `webServer` first (so `ctx.webServer` exists), then `pgstore`, `auth`, and `lookup`.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3200
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: postgres://emr:password@127.0.0.1:5432/deepharness
- name: '@deepseek-ai/dsh-host-auth'
  config:
    keyPair:
      privateKey: <Ed25519 JWK private>
      publicKey:  <Ed25519 JWK public>
    issuer: dsh
    audience: dsh-apiproxy
- name: '@deepseek-ai/dsh-host-lookup'
  config: {}
- name: '@deepseek-ai/dsh-host-server'
  config:
    apiKey: <machine-channel shared secret, min 16 chars>
```

After `apply()`, `ctx.dshServer` is mounted and `webServer.port` listens on the six `/mu/v1/*` paths.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details><summary>Implementation internals — click to expand</summary>

### Design concept

The plugin is glue. Every handler is a `(req, res) => …` factory built from one of the four sibling services; the `ServerService` owns the dispose chain so cordis tear-down walks route disposers in reverse order. The Bearer middleware reads `Authorization: Bearer <apiKey>` and compares the value with `crypto.timingSafeEqual`; the `apiKey` is read from `Config`, never from a request field. Health is intentionally unauthenticated because load balancers cannot carry credentials; the probe does not leak tenant context.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis plugin entry; declares `inject: ['webServer','pgstore','auth','lookup']` |
| [`src/service.ts`](src/service.ts) | `ServerService` extends cordis `Service`; builds the six route specs, registers and disposes them |
| [`src/types.ts`](src/types.ts) | `MuRoute`, `BearerOutcome`, `RequestTenantContext` |
| [`src/error.ts`](src/error.ts) | `ServerError` + `ServerErrorCode` → HTTP status mapping |
| [`src/http.ts`](src/http.ts) | `readJsonBody` (caps at 16 KiB), `writeJson`, `writeOk`, `writeError` |
| [`src/middleware.ts`](src/middleware.ts) | `checkBearer`, `assertBearer`, `AUTHORIZATION_HEADER`, `TENANT_HEADER`, `TRACE_HEADER` |
| [`src/handlers/health.ts`](src/handlers/health.ts) | `makeHealthHandler` — public `GET /mu/v1/health`, 2s pgstore probe |
| [`src/handlers/lookup.ts`](src/handlers/lookup.ts) | `makeLookupHandler` — `GET /mu/v1/lookup`, Bearer + tenant header |
| [`src/handlers/ensure.ts`](src/handlers/ensure.ts) | `makeEnsureHandler(type, deps)` — `POST /mu/v1/ensure/{user,workspace,session}` |
| [`src/handlers/token.ts`](src/handlers/token.ts) | `makeTokenHandler` — `POST /mu/v1/auth/token:issue`, mints EdDSA JWT |

### Handler composition

Each handler is a pure factory: it takes the dependencies it needs (`LookupService`, `AuthService`, `PgStoreService`, `apiKey`) and returns an async `(req, res) => …` function. The server registers the function; the handler owns nothing shared.

### Error shape

Errors respond with `{ ok: false, code, message }`. The `code` is one of `unauthenticated | forbidden | not-found | bad-request | conflict | upstream-unavailable | internal-error`; the HTTP layer maps it to a status with `ServerError.statusFor` so the mapping lives in one place.

</details>

<a id="route-surface"></a>

## Route surface

| Method | Path                              | Auth                | Body / Query                                                                                       | Response                                                                                  |
|--------|-----------------------------------|---------------------|----------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `GET`  | `/mu/v1/health`                   | none (public)       | —                                                                                                  | `{ ok: true, status, service: 'dsh-host-server', pgstore: 'reachable' }`                  |
| `GET`  | `/mu/v1/lookup`                   | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`                 | `?type={user\|workspace\|session}&biz_key=…&tenant_key=…`                                          | `{ ok: true, hit: { … } }` or `{ ok: true, miss: true }`                                  |
| `POST` | `/mu/v1/ensure/user`              | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`                 | `{ bizKey: 'aims.<userCode>', tenantId, attrs? }`                                                  | `{ ok: true, id, bizKey, tenantId, createdAt, updatedAt }`                                |
| `POST` | `/mu/v1/ensure/workspace`         | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`                 | `{ bizKey: 'patient.<cureno>', tenantId, attrs? }`                                                 | same                                                                                      |
| `POST` | `/mu/v1/ensure/session`           | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`                 | `{ bizKey: 'visit.<visitId>', tenantId, attrs? }`                                                  | same                                                                                      |
| `POST` | `/mu/v1/auth/token:issue`         | `Authorization: Bearer <apiKey>`                                   | `{ subject, scopes?, audience?, ttlSeconds? }`                                                    | `{ ok: true, token, jti, expiresAt, audience }`                                           |

The `tenantId` field in `ensure` must match the `X-Dsh-Tenant` header; mismatches answer `400 bad-request`. Callers should always set the header; the body field exists only for symmetry with the lookup query string.

<a id="configuration"></a>

## Configuration

```typescript
interface HostServerConfig {
  readonly apiKey: string   // ≥ 16 chars, constant-time compared to Authorization header
  readonly keyId?: string   // free-form observability label, NOT used for routing
}
```

The plugin never logs the `apiKey`. Operators should source it from a secret manager; rotating it is a config edit + restart.

<a id="known-limitations-and-deferred-work"></a>

## Known limitations and deferred work

- The Bearer middleware uses a single shared key; a future version should split into `(keyId, secret)` pairs with per-pair scopes.
- Scopes are declared in the route table today but not yet enforced (the read / write paths share one secret). The next minor will pull scopes into `checkBearer` as a parallel optional table.
- Audit log writes (`audit_log`) are not yet wired into handlers; the schema is in `migrations/0001_initial.sql` and the trigger is in place. The next patch emits `(tenantId, actor=apimachine, action=lookup|ensure|token:issue, traceId)` rows.
- `POST /mu/v1/workspaces/{id}/members` (member grant) and `POST /mu/v1/workspaces/{id}:archive` are deferred to a sibling plugin; this server only mounts the four endpoints above.

