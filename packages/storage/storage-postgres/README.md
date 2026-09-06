---
description: "PostgreSQL row store with Row-Level Security for the multi-tenant storage backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-postgres

English | [中文](README.zh.md)

## Summary

`dsh-storage-postgres` is the row-store backend the multi-tenant plan calls for: one PostgreSQL database holds the `app_user`, `workspace`, `session_meta`, and supporting tables, every table enforces Row-Level Security so a session can read only the rows its tenant + user owns, and an automated migrations runner stamps the schema on activation. It is *not* a storage hub backend — the hub is KV-only and the row store needs JOIN, foreign keys, and RLS, so this package mounts as `ctx.pgstore` and consumers call `ctx.pgstore.client.withTenant(...)` directly. The package is host-side only and contributes no prompt, tool, or schema, so the model and the agent loop never see it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a composition needs the multi-tenant row store — workspaces, session rows, members, shares, audit log, and the bookkeeping those need. The package owns the connection pool and runs the bundled migrations on activation.

### When to choose it

Choose this package when the deployment runs in Phase 1 (single-process multi-tenant) and needs JOIN-able rows for the storage hub's complement — workspaces, sessions, members, audit. Do not choose it when the deployment is single-tenant and the storage hub's KV backends already cover every need; this package adds a connection pool and a migrations pipeline that pays only when multi-tenant data lands.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: postgres://emr_user@db:5432/shcis_uaiagent?searchpath=dbo
    autoMigrate: true
```

| Field | Default | Meaning |
|---|---|---|
| `connectionString` | required | `pg.PoolConfig.connectionString`. The connection account must NOT be a PostgreSQL superuser — RLS policies are bypassed for superusers and the package's fail-closed guarantees depend on every connection running under the row store's role. |
| `schema` | `dbo` | Postgres `search_path` the wrapper pins via `SET LOCAL` inside every tenant transaction. |
| `maxPoolSize` | `pg` default (10) | Maximum pool size. |
| `idleTimeoutMs` | `pg` default | Idle-connection timeout in ms. |
| `connectionTimeoutMs` | `pg` default | Connection-establishment timeout in ms. |
| `autoMigrate` | `true` | Run bundled migrations during activation. Set to `false` when an external pipeline (`psql -f`, `flyway`, …) owns the schema. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-storage-postgres) is the exhaustive source for every accepted field and its JSDoc.

### Observable behavior

Every `ctx.pgstore.client.withTenant(context, fn)` call acquires a connection, runs `BEGIN`, sets `dsh.tenant` / `dsh.uid` / `dsh.trace_id` via `SELECT set_config(name, value, is_local := true)`, pins `SET LOCAL search_path TO <schema>`, runs the wrapped body, and commits. A failing body or commit triggers `ROLLBACK` before the connection is released; the GUC values vanish at commit and never leak to the next transaction.

Forgetting to call `withTenant` while still reaching for a table that bears RLS raises immediately: `dsh.tenant` is unset, the SECURITY DEFINER helper `dsh_current_tenant()` raises, and the query never reaches the table. Migrations run on a separate `withConnection` path so `schema_migrations` itself can be created before any tenant GUC is in scope.

A migration whose file name is already in `schema_migrations` but whose body checksum has changed rejects with `migration-failed` — drift is treated as a deployment mistake, never silently re-applied.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package separates three concerns that storage hubs usually conflate.

### Design concept

- **`withTenant` is the only path that touches a tenant-bearing table.** It is the place where the GUC pinning, the `search_path`, and the transaction boundary meet. Every other primitive — `withConnection`, `query` — is admin-only and exists for migrations and bootstrapping.
- **RLS does the multi-tenant filtering, not the application.** The application never writes `WHERE tenant_id = ...`. The schema declares the policies, the SECURITY DEFINER helpers `dsh_current_tenant()` and `dsh_current_uid()` read the GUC, and a trigger on `audit_log` rejects rows whose `tenant_id` would not match the GUC — belt-and-braces against accidental cross-tenant writes that slip past an `INSERT` whose RLS policy only checks the row.
- **Migrations are idempotent and check-summed.** `schema_migrations` records `(file, checksum, applied_at)`. A re-run skips a file whose recorded checksum still matches the body. A file whose name is recorded but whose checksum no longer matches raises `migration-failed` — the author must bump the numeric prefix and add a new file.
- **The pool is closed by an effect.** The plugin's `apply()` registers `ctx.pgstore` and then attaches an effect whose disposer calls `client.close()`. The plugin itself never holds the pool across the cordis teardown; the effect does, so an externally disposed context still drains the pool cleanly.

### Pool lifecycle

Activation (`ctx.pgstore.activate()`) is idempotent: a concurrent or repeat call resolves to the same `MigrationResult`. `close()` waits for any in-flight activation to settle, then calls `pg.Pool.end()`. Post-close acquisitions raise `pool-closed`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name` / `inject` / `Config` / `apply`, mounts `ctx.pgstore`, schedules migrations and pool close |
| [`src/service.ts`](src/service.ts) | `PgStoreService`: idempotent `activate()`, `close()`, schema/default resolution |
| [`src/client.ts`](src/client.ts) | `PgClient`: pool owner, `withTenant` / `withConnection` / `query`, `SET LOCAL search_path` |
| [`src/migrate.ts`](src/migrate.ts) | `loadMigrations`, `migrationChecksum`, `applyMigrations` (idempotent + drift guard) |
| [`src/error.ts`](src/error.ts) | `DshPostgresError` with stable error codes |
| [`src/types.ts`](src/types.ts) | Branded ids (`TenantId`, `UserId`, `WorkspaceId`, `SessionId`), `TenantContext`, `Migration`, `MigrationResult` |
| [`migrations/0001_initial.sql`](migrations/0001_initial.sql) | 11 tables + indices + tenant-trigger |
| [`migrations/0002_rls.sql`](migrations/0002_rls.sql) | RLS policies + SECURITY DEFINER helpers |
| [`migrations/0003_biz_key.sql`](migrations/0003_biz_key.sql) | `biz_key` + `UNIQUE (tenant_id, biz_key)` + `status` / `privacy` columns |
| [`migrations/0010_test_data.sql`](migrations/0010_test_data.sql) | 1 tenant / 3 users / 3 workspaces / 5 sessions fixture set |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this backend's view is not enough: the storage subsystem reference is the authoritative contract, and the multi-tenant plan is the design source of record.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the hub contract, the domain form, and the KV backend family.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [Multi-tenant plan](../../../docs/multi-tenant.html) — the design rationale, the `biz_key` three-prefix convention, and the Phase 1 boundary.
- [AIMS-DSH integration plan](../../../docs/AIMS-DSH多租户对接方案.html) — the cross-system contract plan and the mock-stub-first Phase 1 path.

-----

<a id="model-experience"></a>
## Model Experience

### Stored records

#### What the model sees

Nothing. This package contributes no prompt, tool, or schema; it persists multi-tenant domain data behind `ctx.pgstore` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the package never touches live request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Single-process Phase 1** — the multi-tenant plan treats a single Node process as the deployment unit; multi-process deployments need a coordination layer the package does not provide.
- **RLS depends on the connection role** — operators must connect as a non-superuser account (`emr_user`-style), otherwise every row passes the policy. The `set_config` GUC pinning is bypassed too, so a superuser client would silently read everything.
- **Migrations run on every activation by default** — an external migration pipeline must set `autoMigrate: false` or accept the apply-then-skip behaviour. Concurrent activations racing the first apply are serialised inside `PgStoreService.activate()`, but the underlying `pg.Pool` will queue if multiple processes boot at once.
- **`schema_migrations` drift is a hard error** — editing a migration's body after it has been applied raises `migration-failed`. The remedy is a new file with a higher numeric prefix, never an in-place rewrite.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>