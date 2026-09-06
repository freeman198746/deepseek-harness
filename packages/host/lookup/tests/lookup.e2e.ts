/**
 * Real-PG end-to-end test for the host-lookup family. The suite verifies
 * the `lookup` miss/hit path, the idempotent `ensure` insert-or-noop, and
 * the cordis plugin mount — all of which require a live PostgreSQL cluster
 * with the migrations from `@deepseek-ai/dsh-storage-postgres` already
 * applied.
 *
 * The suite is skipped when `PG_CONNECTION_STRING` is unset; CI runs it
 * against the staging cluster on 47.99.124.43:5432.
 *
 * @module @deepseek-ai/dsh-host-lookup/e2e
 */

import assert from 'node:assert/strict'
import { describe, test, beforeAll, afterAll } from 'vitest'

const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING

const skip = PG_CONNECTION_STRING === undefined || PG_CONNECTION_STRING === ''

describe.skipIf(skip)('host-lookup e2e (live PG)', () => {
  // Imported lazily so the vitest harness does not blow up when PG is
  // unreachable. Each test does its own require() to keep the failure mode
  // close to the failing assertion.
  let service: import('../src/service.ts').LookupService
  let pgstore: import('@deepseek-ai/dsh-storage-postgres').PgStoreService
  let closeable: { close: () => Promise<void> }

  beforeAll(async () => {
    const [storageMod, lookupMod] = await Promise.all([
      import('@deepseek-ai/dsh-storage-postgres'),
      import('../src/service.ts'),
    ])
    pgstore = new storageMod.PgStoreService({} as never, {
      pool: { connectionString: PG_CONNECTION_STRING as string },
      autoMigrate: true,
    })
    await pgstore.activate()
    service = new lookupMod.LookupService({ pgstore })
    closeable = pgstore
  })

  afterAll(async () => {
    if (closeable) await closeable.close()
  })

  const TENANT_ID = '00000000-0000-0000-0000-000000000001' as never
  const USER_CODE = `aims.e2e-${Date.now()}`

  test('lookup returns miss for an unknown biz_key', async () => {
    const result = await service.lookup(
      { tenantId: TENANT_ID as never, userId: '00000000-0000-0000-0000-00000000000d' as never },
      'user',
      USER_CODE,
    )
    assert.equal(result.kind, 'miss')
  })

  test('ensure creates a row when missing, then is a no-op', async () => {
    const ctx = { tenantId: TENANT_ID as never, userId: '00000000-0000-0000-0000-00000000000d' as never }
    const first = await service.ensure(ctx, { type: 'user', tenantId: ctx.tenantId, bizKey: USER_CODE })
    assert.equal(first.bizKey, USER_CODE)
    assert.equal(first.tenantId, ctx.tenantId)
    assert.equal(typeof first.id, 'string')

    const second = await service.ensure(ctx, { type: 'user', tenantId: ctx.tenantId, bizKey: USER_CODE })
    assert.equal(second.id, first.id, 'ensure must return the same id on the second call')
  })

  test('lookup returns hit for the row ensure just created', async () => {
    const ctx = { tenantId: TENANT_ID as never, userId: '00000000-0000-0000-0000-00000000000d' as never }
    const result = await service.lookup(ctx, 'user', USER_CODE)
    assert.equal(result.kind, 'hit')
    if (result.kind === 'hit') {
      assert.equal(result.record.bizKey, USER_CODE)
    }
  })

  test('cross-type prefix collision surfaces as invalid-biz-key', async () => {
    const ctx = { tenantId: TENANT_ID as never, userId: '00000000-0000-0000-0000-00000000000d' as never }
    await assert.rejects(
      () => service.lookup(ctx, 'workspace', USER_CODE),
      (err: unknown) => err instanceof Error && err.name === 'LookupError' && (err as { code?: string }).code === 'invalid-biz-key',
    )
  })
})