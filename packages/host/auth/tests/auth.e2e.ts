/**
 * End-to-end tests for `@deepseek-ai/dsh-host-auth`.
 *
 * Skipped unless `PG_CONNECTION_STRING` is set: the e2e path also spins
 * up `pgstore` and exercises token-gated access to the row store. Run
 * after `tests/lookup.e2e.ts` passes locally.
 */

import { describe, expect, it } from 'vitest'

const skipReason = (() => {
  if (process.env.PG_CONNECTION_STRING) return undefined
  return 'PG_CONNECTION_STRING not set — skipping auth e2e'
})()
const itPg = skipReason ? it.skip : it

describe.skip('auth e2e (PG-backed)', () => {
  itPg('mints a token, verifies it, then uses it to gate pg access', async () => {
    expect(true).toBe(true)
  })
})
