/**
 * Contract tests for `@deepseek-ai/dsh-host-server`.
 *
 * Verified offline via `.workbuddy/smoke.ts` because the workspace
 * vitest harness currently refuses new package-level suites. When the
 * harness supports a per-package config, the same assertions move here.
 *
 * The e2e tests live in `tests/server.e2e.ts` and require both PG and a
 * live host (the plugin composes four siblings; a cordis integration
 * test exercises them all end to end).
 */
import { describe, expect, it } from 'vitest'
import { ServerError, isServerError } from '../src/error.ts'
import { checkBearer, assertBearer } from '../src/middleware.ts'

describe('ServerError', () => {
  it('maps codes to the matching HTTP status', () => {
    expect(ServerError.statusFor('unauthenticated')).toBe(401)
    expect(ServerError.statusFor('forbidden')).toBe(403)
    expect(ServerError.statusFor('not-found')).toBe(404)
    expect(ServerError.statusFor('bad-request')).toBe(400)
    expect(ServerError.statusFor('conflict')).toBe(409)
    expect(ServerError.statusFor('upstream-unavailable')).toBe(503)
    expect(ServerError.statusFor('internal-error')).toBe(500)
  })

  it('sets the httpStatus from the code on construction', () => {
    const e = new ServerError('not-found', 'no row')
    expect(e.httpStatus).toBe(404)
    expect(e.code).toBe('not-found')
    expect(isServerError(e)).toBe(true)
  })
})

describe('Bearer middleware', () => {
  const KEY = 'machine-channel-secret-32-chars-long-xx'
  it('returns authed on exact match', () => {
    const r = checkBearer(`Bearer ${KEY}`, KEY)
    expect(r.kind).toBe('authed')
  })

  it('returns unauthenticated when the header is missing', () => {
    const r = checkBearer(undefined, KEY)
    expect(r.kind).toBe('unauthenticated')
  })

  it('returns malformed when the scheme is wrong', () => {
    const r = checkBearer(`Basic ${KEY}`, KEY)
    expect(r.kind).toBe('malformed')
  })

  it('returns unauthenticated on a wrong secret (length difference too)', () => {
    const r = checkBearer('Bearer wrong-key', KEY)
    expect(r.kind).toBe('unauthenticated')
  })

  it('assertBearer raises ServerError for non-authed outcomes', () => {
    const r = checkBearer('Basic xx', KEY)
    expect(() => assertBearer(r)).toThrow(ServerError)
  })
})
