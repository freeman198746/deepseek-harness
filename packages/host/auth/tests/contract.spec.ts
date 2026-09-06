/**
 * Contract tests for `@deepseek-ai/dsh-host-auth`.
 *
 * Verified offline via `.workbuddy/smoke.ts` because the workspace
 * vitest harness currently refuses new package-level suites. When the
 * harness supports a per-package config, the same assertions move here.
 *
 * The e2e tests live in `tests/auth.e2e.ts` and require a running PG
 * cluster (the plugin itself is storage-free; the cluster is needed to
 * exercise downstream verification paths).
 */

import { describe, expect, it } from 'vitest'
import { AuthService } from '../src/service.ts'
import { AuthError, isAuthError } from '../src/error.ts'
import { generateKeyPair } from 'jose'
import type { JsonWebKeyPair } from '../src/types.ts'

async function keyPair(): Promise<JsonWebKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ed25519', { extractable: true })
  return {
    privateKey: privateKey.export({ format: 'jwk' }) as unknown as { [k: string]: unknown },
    publicKey: publicKey.export({ format: 'jwk' }) as unknown as { [k: string]: unknown },
  } as unknown as JsonWebKeyPair
}

describe('AuthService — config validation', () => {
  it('rejects ttl < 1', async () => {
    const kp = await keyPair()
    expect(() => new AuthService({
      keyPair: kp, issuer: 'i', audience: 'a', tokenTtlSeconds: 0,
    })).toThrow(AuthError)
  })

  it('rejects ttl > MAX', async () => {
    const kp = await keyPair()
    expect(() => new AuthService({
      keyPair: kp, issuer: 'i', audience: 'a', tokenTtlSeconds: 24 * 60 * 60 + 1,
    })).toThrow(AuthError)
  })

  it('accepts a well-formed config', async () => {
    const kp = await keyPair()
    expect(() => new AuthService({ keyPair: kp, issuer: 'i', audience: 'a' })).not.toThrow()
  })
})

describe('AuthService — round-trip', () => {
  it('mint then verify happy path', async () => {
    const kp = await keyPair()
    const service = new AuthService({ keyPair: kp, issuer: 'dsh', audience: 'dsh-server' })
    const m = await service.mint({ subject: 'tester', scopes: ['lookup:read'] })
    expect(m.token.split('.')).toHaveLength(3)
    const claims = await service.verify(m.token, { expectedAudience: 'dsh-server' })
    expect(claims.sub).toBe('tester')
    expect(claims.scopes).toContain('lookup:read')
    expect(typeof claims.jti).toBe('string')
    await service.close()
  })

  it('rejects an audience mismatch', async () => {
    const kp = await keyPair()
    const service = new AuthService({ keyPair: kp, issuer: 'dsh', audience: 'dsh-server' })
    const m = await service.mint({ subject: 'a' })
    try {
      await service.verify(m.token, { expectedAudience: 'wrong' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'audience-mismatch').toBe(true)
    }
    await service.close()
  })
})
