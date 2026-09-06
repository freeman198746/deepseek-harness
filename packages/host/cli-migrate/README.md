---
description: "The `dsh-migrate-multiuser` operator command (#14): applies / plans the multi-tenant schema shipped by @deepseek-ai/dsh-storage-postgres against a live PostgreSQL cluster."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-cli-migrate

English | [中文](README.zh.md)

## Summary

`dsh-migrate-multiuser` is the operator-side companion to `@deepseek-ai/dsh-storage-postgres`. It ships the four `0001_initial.sql` / `0002_rls.sql` / `0003_biz_key.sql` / `0004_ensure_attributes.sql` migrations — `tenant`, `app_user`, `workspace`, `workspace_member`, `session_meta`, `session_share`, `memory`, `artifact`, `plugin`, `plugin_policy`, `audit_log`, RLS policies, `biz_key` UNIQUE indexes, `status` / `privacy` CHECK constraints, and `attrs JSONB` — to a live PostgreSQL cluster. The CLI is intentionally narrow: read `PG_CONNECTION_STRING`, construct one `PgStoreService` with `autoMigrate: false`, call `applyMigrations`, report applied / skipped. The `--plan` flag prints the bundle without touching the database so dev / pre-flight runs need no credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>

## Use this package

### Install via `pnpm dlx`

```bash
pnpm dlx dsh-migrate-multiuser --plan
pnpm dlx dsh-migrate-multiuser --run
```

### Install as a dev dependency

```bash
pnpm add -D @deepseek-ai/dsh-host-cli-migrate
```

Once installed, the `dsh-migrate-multiuser` binary is on the path. Both flows default to reading `PG_CONNECTION_STRING` from the environment:

```bash
export PG_CONNECTION_STRING=postgres://emr:password@db.internal:5432/deepharness
export DSH_PG_SCHEMA=dbo          # optional; defaults to "dbo"

dsh-migrate-multiuser --run      # applies migrations in file order
dsh-migrate-multiuser --plan     # prints files, no DB touched
```

The exit code follows the same conventional stream as `dsh` / `psql`:

| Code | Meaning |
|------|---------|
| `0`  | applied or already up to date |
| `64` | usage error (unknown flag) |
| `65` | missing `PG_CONNECTION_STRING` |
| `70` | schema-version drift (a recorded file was edited) |
| `75` | network/connection failure |
| `1`  | unexpected error |

### Use the library from another script

```ts
import { runCli } from '@deepseek-ai/dsh-host-cli-migrate/src/cli.ts'

const code = await runCli(['--plan'], (s) => process.stdout.write(s), (s) => process.stderr.write(s))
process.exit(code)
```

<a id="understand-the-implementation"></a>

## Understand the implementation

<details><summary>Implementation internals — click to expand</summary>

### Design concept

The CLI is glue between an operator shell and `applyMigrations`. It does its own argv parsing because adding `commander` would push the bundle past two dependencies when the shape is six flags; the abstraction `runCli(argv, stdout, stderr)` lets tests substitute the streams.

### Source map

| File | Role |
|---|---|
| [`src/cli.ts`](src/cli.ts) | `parseArgs`, `runCli`, `render`, `listMigrations`, `runMigrations`, `ExitCode`, `CliUsageError`, `printHelp` |
| [`bin/dsh-migrate-multiuser`](bin/dsh-migrate-multiuser) | Shebang shim, delegates to `index.ts` |
| [`index.ts`](index.ts) | Public entry: `await runCli(process.argv.slice(2)); process.exit(code)` |

### Why `autoMigrate: false` here

`PgStoreService` runs migrations on `activate()` when `autoMigrate: true` (the plugin default for ergonomic activation). A CLI invocation does NOT want that — the operator expects an explicit "applied N files" report rather than a silent side effect. We pass `autoMigrate: false` and call `applyMigrations` ourselves so the output is auditable.

### Why a separate package

`dsh host-lookup` and `dsh host-server` are run inside a long-lived cordis process; `dsh-migrate-multiuser` is a one-shot operator command. Combining the two would force the operator to pull in `dsh-host-webserver` / `dsh-host-auth` / `dsh-host-lookup` as transitive dev-deps that the CLI never uses.

</details>

<a id="known-limitations-and-deferred-work"></a>

## Known limitations and deferred work

- `--to-postgres` (the "promote the local JSONL store to multi-user PG") flow described in DSH plan §14 is not implemented: Phase 1 ships `dsh migrate multiuser --run`, the upgrade from local CLI is a separate operator workflow.
- `--dry-run` / SQL preview — today's `--plan` lists the files but does not dump the SQL. Use `--plan` plus `cat migrations/$(pick)` for that today; a `--sql` flag follows once the use case reappears.

<a id="dev-note"></a>

## Dev note

`bin/dsh-migrate-multiuser` does NOT escape `--import tsx` when bundled; the shebang assumes the host has `tsx` on its PATH. A future `--bundle` step will emit a self-contained `.js` shim with `tsx` baked in.
