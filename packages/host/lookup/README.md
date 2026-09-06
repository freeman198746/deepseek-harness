---
description: "Host-side reverse-lookup and ensure orchestrator over the multi-tenant row store; resolves (tenant_id, biz_key) to UUID primary keys with idempotent ensure."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-lookup

English | [中文](README.zh.md)

## Summary

`dsh-host-lookup` is the host-side orchestrator for the multi-tenant reverse-lookup family. It takes a stable business key the host already uses (`aims.{userCode}` / `patient.{cureno}` / `visit.{visitId}`) and resolves it to a UUID inside the tenant it belongs to. It also provides an idempotent `ensure` call that inserts a minimal row on miss and returns the existing one on hit. It mounts as `ctx.lookup`; the package does **not** register HTTP routes — wiring `GET /mu/v1/lookup` and `POST /mu/v1/ensure/{type}` is the responsibility of `@deepseek-ai/dsh-server`.

The package depends on `@deepseek-ai/dsh-storage-postgres` for the connection pool and migration bootstrap. It does not speak SQL to the multi-tenant schema directly; every read and write goes through `ctx.pgstore.client.withTenant(...)` so the `dsh.tenant` / `dsh.uid` / `dsh.trace_id` GUC trio is pinned for the transaction and Row-Level Security does the rest.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

When the host needs to map a stable business key (the `userCode` it stores on its own user table, the `cureno` of an EMR record, or the `visitId` of a clinical visit) onto the UUID DSH uses internally, use this package. Phase 1 deployments — AIMS talking to DSH — drive this mapping on every panel render; the `UNIQUE (tenant_id, biz_key)` index on each in-scope table keeps the round-trip in the O(1) millisecond range.

### When to choose

Use this package whenever a host-side identity needs to land in DSH storage as a foreign key or join column. Skip it when the host already has its own UUID (no biz_key involvement) or when the relationship is one-shot and a manual SQL `INSERT` is acceptable.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-host-lookup'
  config:
    allowEnsureInsert: true
```

| Field | Default | Meaning |
|---|---|---|
| `allowEnsureInsert` | `true` | When `true`, `ensure` is allowed to insert rows for unknown biz_keys. Set `false` for read-only deployments where a missing record is always a bug. |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-lookup) is the exhaustive source of truth for every supported field and its JSDoc.

### Observable behavior

Every `ctx.lookup.{user,workspace,session}(bizKey)` call opens a transaction, pins `dsh.tenant` / `dsh.uid`, runs a single-row SELECT on the in-scope table, commits. A miss returns `{ kind: 'miss' }` and is normal — it is not an error.

`ctx.lookup.{user,workspace,session}.ensure({ tenantId, bizKey })` runs an `INSERT ... ON CONFLICT (tenant_id, biz_key) DO NOTHING` followed by a SELECT on the same predicate. The second statement reads back whatever the INSERT left behind (new row or pre-existing one). Both statements run inside the same tenant transaction so RLS sees consistent state.

If a caller passes a `bizKey` whose prefix does not match the requested type (`aims.*` reserved for `user`, `patient.*` for `workspace`, `visit.*` for `session`), the call throws `LookupError` with `code: 'invalid-biz-key'` before touching the database. The prefix is enforced because the storage schema indexes on `(tenant_id, biz_key)` — a wrong prefix would either collide with another namespace's row or silently miss the right one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

This package is a thin orchestrator; the heavy lifting lives in `@deepseek-ai/dsh-storage-postgres`.

### Design philosophy

- **`withTenant` is the only entry point for protected tables.** The `dsh.tenant` / `dsh.uid` GUCs are pinned by the underlying `pg.Pool` wrapper, RLS policies in `migrations/0002_rls.sql` enforce the row filter, and `audit_log` rejects any cross-tenant write. The lookup family inherits all three guarantees.
- **The three-prefix convention is enforced at the API boundary, not in SQL.** The schema only carries a `biz_key` column with a uniqueness constraint; the prefix meaning is a host-side contract this plugin validates before issuing SQL.
- **`ensure` is two statements inside one transaction.** The INSERT and the SELECT must see the same snapshot, and a CTE that does both in one shot is harder to keep correct as `attrs` columns land. The two-statement form is intentional.
- **No HTTP routes.** Mounting `/mu/v1/lookup` and `/mu/v1/ensure/{type}` belongs to `@deepseek-ai/dsh-server` so this package stays HTTP-free and reusable from non-HTTP contexts (CLI tools, scripts, jest suites).

### Lookup table mapping

| Type | Table | ID column | Reserved prefix |
|---|---|---|---|
| `user` | `app_user` | `user_id` | `aims` |
| `workspace` | `workspace` | `workspace_id` | `patient` |
| `session` | `session_meta` | `session_id` | `visit` |

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis plugin entry: `name` / `inject` / `Config` / `apply`, mounts `ctx.lookup` |
| [`src/service.ts`](src/service.ts) | `LookupService`: `lookup(type, bizKey, ctx)` and `ensure(request, ctx)` |
| [`src/biz-key.ts`](src/biz-key.ts) | `validateBizKey` + `extractBizKeyPrefix`, the three-prefix convention |
| [`src/error.ts`](src/error.ts) | `LookupError` and the stable `LookupErrorCode` union |
| [`src/types.ts`](src/types.ts) | Branded ids, `LookupType` / `BizKey` / `BizKeyPrefix`, `LookupOutcome` discriminated union |
| [`tests/contract.spec.ts`](tests/contract.spec.ts) | Vitest: prefix table, `validateBizKey` accept/reject matrix, `extractBizKeyPrefix` |
| [`tests/lookup.e2e.ts`](tests/lookup.e2e.ts) | Vitest e2e: lookup miss, ensure idempotency, lookup hit — skipped without `PG_CONNECTION_STRING` |

</details>

-----

<a id="further-exploration"></a>
## Further exploration

Read these pages when this orchestrator's view is not enough: the storage subsystem reference is the authoritative contract, and the multi-tenant plan is the design source of record.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the hub contract, the domain form, and the KV backend family.
- [Multi-tenant plan](../../../docs/multi-tenant.html) — the design rationale, the `biz_key` three-prefix convention, and the Phase 1 boundary.
- [AIMS-DSH integration plan](../../../docs/AIMS-DSH多租户对接方案.html) — the cross-system contract plan and the mock-stub-first Phase 1 path.

-----

<a id="model-experience"></a>
## Model experience

### Stored records

#### What the model sees

Nothing. This package contributes no prompt, tool, or schema; it is an internal orchestrator the host calls when it needs to translate business keys to UUIDs. The model never invokes `ctx.lookup` directly.

#### Token effect

Zero. `LookupService` is invoked synchronously by the host, not from the agent loop.

#### KV cache effect

None. The lookup family never touches the request prefix.

## Known limitations and deferred work

<a id="known-limitations-and-deferred-work"></a>

These limitations describe when the orchestrator is not the right tool or when additional operational care is required. They are package constraints, not a backlog of work.

- **`attrs` is advisory only.** The multi-tenant schema does not carry a free-form JSONB column on the in-scope tables. `ensure` will create a row with `tenant_id` + `biz_key` and ignore any `attrs` the caller passes. Migration `0004_ensure_attributes.sql` (planned, not written) will add `attributes JSONB` to `app_user` / `workspace` / `session_meta`; this package will then start writing the column.
- **Phase 1 single-process.** Multi-tenant deployments target a single Node process. Multi-process deployments would need a coordination layer this package does not provide.
- **Lookup depends on storage-postgres being mounted.** If `@deepseek-ai/dsh-host-lookup` is loaded before `@deepseek-ai/dsh-storage-postgres`, `ctx.pgstore` is `undefined` and `apply()` will throw at activation time. The `inject: ['pgstore']` declaration enforces the order, but consumers that build custom registries should check `ctx.pgstore` themselves.

<a id="dev-note"></a>
### Dev note

<details>
<summary>Maintainer context — click to expand</summary>

This package is the API surface that AIMS' `DshLookupService` calls during Phase 1 mock-stubs. The HTTP routes it produces live in `@deepseek-ai/dsh-server`. The `attrs` follow-up is the next migration to plan and ship — keep the `attributes JSONB` column nullable so existing rows survive the rollout.

</details>