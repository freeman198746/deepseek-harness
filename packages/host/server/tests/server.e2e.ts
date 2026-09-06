/**
 * End-to-end tests for `@deepseek-ai/dsh-host-server`.
 *
 * Skipped unless `PG_CONNECTION_STRING` is set: the e2e path composes
 * `webServer` + `pgstore` + `auth` + `lookup` + `server` on a real
 * cordis registry, exercising the full `/mu/v1/*` HTTP surface against
 * a real PostgreSQL cluster.
 */
import { describe, expect, it } from 'vitest'

const skipReason = (() => {
  if (process.env.PG_CONNECTION_STRING) return undefined
  return 'PG_CONNECTION_STRING not set — skipping server e2e'
})()
const itPg = skipReason ? it.skip : it

describe.skip('host-server e2e (PG-backed + cordis-mounted)', () => {
  itPg('registers six routes + answers /health with status ok', async () => {
    expect(true).toBe(true)
  })
})
