/**
 * End-to-end test against a real PostgreSQL instance. The suite self-skips
 * when `PG_CONNECTION_STRING` is unset — CI runs it through the seeded
 * `shcis_uaiagent` cluster; local developers can launch a container and
 * export the env var to opt in.
 *
 * The suite runs in this order:
 *
 * 1. `applyMigrations` against the configured schema — applies every
 *    bundled SQL file (idempotent on re-runs).
 * 2. `applyMigrations` a second time — every file lands in `skipped`.
 * 3. A tampered checksum refuses to re-apply (proves the drift guard).
 * 4. `PgClient.withTenant` sets `dsh.tenant` / `dsh.uid` / `dsh.trace_id`
 *    inside the wrapped transaction.
 * 5. The GUC vanishes once the transaction commits.
 * 6. The cordis plugin mounts `ctx.pgstore`.
 *
 * @module @deepseek-ai/dsh-storage-postgres/tests/load-path
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PgClient } from '../src/client.ts'
import { applyMigrations, loadMigrations } from '../src/migrate.ts'
import type { Migration, TenantContext } from '../src/types.ts'

const connectionString = process.env['PG_CONNECTION_STRING']
const skip = connectionString === undefined || connectionString.length === 0
const skipReason = 'set PG_CONNECTION_STRING to run this suite'

let pg: PgClient

beforeAll(async () => {
  if (skip) return
  pg = new PgClient({
    pool: { connectionString: connectionString! },
    schema: 'dbo',
  })
  await applyMigrations(pg)
}, 60_000)

afterAll(async () => {
  if (skip) return
  await pg.close()
})

describe('dsh-storage-postgres real PG path', () => {
  it.skipIf(skip, skipReason)('records every bundled migration on first apply', async () => {
    const result = await applyMigrations(pg)
    // First pass at this cluster: every file lands in `applied`. Tests that
    // run after this see the same recording table; idempotence is the next
    // test's responsibility.
    expect(result.applied.length).toBeGreaterThan(0)
    expect(result.skipped).toEqual([])
    for (const [file, checksum] of result.recorded) {
      expect(file.endsWith('.sql')).toBe(true)
      expect(checksum).toMatch(/^[0-9a-f]{64}$/)
    }
  }, 60_000)

  it.skipIf(skip, skipReason)('re-runs as a no-op once migrations are recorded', async () => {
    const second = await applyMigrations(pg)
    expect(second.applied).toEqual([])
    expect(second.skipped.length).toBeGreaterThan(0)
  }, 60_000)

  it.skipIf(skip, skipReason)('refuses to apply a tampered body whose file name is already recorded', async () => {
    const migrations: Migration[] = await loadMigrations()
    const target = migrations[0]!
    const fake: Migration = { file: target.file, sql: `${target.sql}\n-- tampered` }
    await expect(applyMigrations(pg, [fake])).rejects.toThrow(/already recorded with checksum/)
  }, 60_000)

  it.skipIf(skip, skipReason)('withTenant pins the GUC for the body of the transaction', async () => {
    const context: TenantContext = {
      tenantId: `t-${randomUUID()}` as TenantContext['tenantId'],
      userId: `u-${randomUUID()}` as TenantContext['userId'],
      traceId: `trace-${randomUUID()}`,
    }
    const observed = await pg.withTenant(context, async (client) => {
      const row = await client.query<{ tenant: string | null; uid: string | null; trace: string | null }>(
        `SELECT
           current_setting('dsh.tenant', true) AS tenant,
           current_setting('dsh.uid',    true) AS uid,
           current_setting('dsh.trace_id', true) AS trace`,
      )
      return row.rows[0]!
    })
    expect(observed.tenant).toBe(context.tenantId)
    expect(observed.uid).toBe(context.userId)
    expect(observed.trace).toBe(context.traceId)
  }, 30_000)

  it.skipIf(skip, skipReason)('the GUC vanishes once the transaction commits', async () => {
    const context: TenantContext = {
      tenantId: `t-${randomUUID()}` as TenantContext['tenantId'],
      userId: `u-${randomUUID()}` as TenantContext['userId'],
    }
    await pg.withTenant(context, async () => { /* drain */ })
    // `pg.query` opens its own implicit transaction; SET LOCAL settings from
    // a prior transaction must not leak.
    const after = await pg.query<{ tenant: string | null }>(
      `SELECT current_setting('dsh.tenant', true) AS tenant`,
    )
    expect(after.rows[0]!.tenant).toBeNull()
  }, 30_000)

  it.skipIf(skip, skipReason)('the storage-postgres plugin mounts pgstore on the cordis context', async () => {
    const ctx = new Context()
    const mod = await import('../src/index.ts')
    await ctx.plugin(mod, { connectionString: connectionString! })
    expect(ctx.pgstore).toBeDefined()
    expect(ctx.pgstore.client).toBeInstanceOf(PgClient)
    await ctx.pgstore.activate()
    await ctx.pgstore.close()
  }, 60_000)
})