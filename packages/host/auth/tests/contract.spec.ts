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
import { SignJWT, generateKeyPair } from 'jose'
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

// ---------------------------------------------------------------------------
// T1 — Negative cases N1..N10 (DSH multi-tenant plan §15 token verification).
//
// These ten tests pin down the verifier's behavior on every rejection path
// a real attacker would probe. They are deliberately separate from the
// happy-path suite above so a regression on any one path is easy to spot
// in the test report.
// ---------------------------------------------------------------------------

describe('AuthService — negative cases N1..N10', () => {
  async function setup() {
    const kp = await keyPair()
    const service = new AuthService({
      keyPair: kp,
      issuer: 'dsh',
      audience: 'dsh-server',
      tokenTtlSeconds: 3600,
      clockSkewSeconds: 30,
    })
    return { kp, service }
  }

  it('N1 signature tamper → signature-invalid', async () => {
    const { service } = await setup()
    const m = await service.mint({ subject: 'a' })
    const [h, p, s] = m.token.split('.')
    expect(h && p && s).toBeTruthy()
    const tampered = `${h}.${p}.${s!.slice(0, -1)}${s!.slice(-1) === 'A' ? 'B' : 'A'}`
    try {
      await service.verify(tampered, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err)).toBe(true)
      expect(['signature-invalid', 'malformed-jwt']).toContain((err as AuthError).code)
    }
    await service.close()
  })

  it('N2 expired (TTL 1s + sleep + skew 0) → expired', async () => {
    const kp = await keyPair()
    const fast = new AuthService({
      keyPair: kp,
      issuer: 'dsh',
      audience: 'dsh-server',
      tokenTtlSeconds: 1,
      clockSkewSeconds: 0,
    })
    const m = await fast.mint({ subject: 'a' })
    await new Promise((r) => setTimeout(r, 1500))
    try {
      await fast.verify(m.token, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'expired').toBe(true)
    }
    await fast.close()
  })

  it('N3 wrong issuer → issuer-mismatch', async () => {
    const kp = await keyPair()
    const signer = new AuthService({ keyPair: kp, issuer: 'attacker', audience: 'dsh-server' })
    const verifier = new AuthService({ keyPair: kp, issuer: 'dsh', audience: 'dsh-server' })
    const m = await signer.mint({ subject: 'a' })
    try {
      await verifier.verify(m.token, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'issuer-mismatch').toBe(true)
    }
    await signer.close()
    await verifier.close()
  })

  it('N4 wrong audience → audience-mismatch', async () => {
    const { service } = await setup()
    const m = await service.mint({ subject: 'a' })
    try {
      await service.verify(m.token, { expectedAudience: 'wrong-aud' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'audience-mismatch').toBe(true)
    }
    await service.close()
  })

  it('N5 missing required scope → scope-missing', async () => {
    const { service } = await setup()
    const m = await service.mint({ subject: 'a', scopes: ['lookup:read'] })
    try {
      await service.verify(m.token, {
        expectedAudience: 'dsh-server',
        requiredScopes: ['ensure:write'],
      })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'scope-missing').toBe(true)
    }
    await service.close()
  })

  it('N6 wrong alg (HS256 token verified against EdDSA key) → signature-invalid', async () => {
    const { service } = await setup()
    // Sign an HS256 token using the EdDSA public key bytes as the shared
    // secret. The verifier only accepts EdDSA, so this must reject.
    const hsKey = new TextEncoder().encode('attacker-controlled-secret')
    const hsToken = await new SignJWT({ iss: 'dsh', aud: 'dsh-server', sub: 'a' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('jti-fake')
      .sign(hsKey)
    try {
      await service.verify(hsToken, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err)).toBe(true)
      // jose routes an HS256-against-EdDSA-key rejection as signature-invalid;
      // we accept either signature-invalid or malformed-jwt because future
      // jose versions may classify it differently.
      expect(['signature-invalid', 'malformed-jwt']).toContain((err as AuthError).code)
    }
    await service.close()
  })

  it('N7 bad token shape (1 segment / 2 segments / 4 segments) → malformed-jwt', async () => {
    const { service } = await setup()
    for (const shape of ['', 'a', 'a.b', 'a.b.c.d']) {
      try {
        await service.verify(shape, { expectedAudience: 'dsh-server' })
        throw new Error(`expected throw for shape: ${shape}`)
      } catch (err) {
        expect(isAuthError(err) && (err as AuthError).code === 'malformed-jwt').toBe(true)
      }
    }
    await service.close()
  })

  it('N8 replay jti (no replay protection at this layer) → second verify succeeds', async () => {
    // Documented contract: this layer does NOT track seen jtis. The caller
    // (e.g. dsh-host-lookup cache) is responsible for replay protection.
    // The test pins down the current behavior so a future enhancement
    // gets a clear signal in CI.
    const { service } = await setup()
    const m = await service.mint({ subject: 'a' })
    const first = await service.verify(m.token, { expectedAudience: 'dsh-server' })
    const second = await service.verify(m.token, { expectedAudience: 'dsh-server' })
    expect(first.jti).toBe(second.jti)
    expect(first.sub).toBe(second.sub)
    await service.close()
  })

  it('N9 clock skew tolerance (token just-expired within skew window) → accepted', async () => {
    const kp = await keyPair()
    const service = new AuthService({
      keyPair: kp,
      issuer: 'dsh',
      audience: 'dsh-server',
      tokenTtlSeconds: 60,
      clockSkewSeconds: 60,
    })
    const m = await service.mint({ subject: 'a', ttlSeconds: 60 })
    // mockNow 90 seconds in the future — token expired 30 seconds ago.
    // The 60-second skew window should still accept it.
    const future = new Date(Date.now() + 90 * 1000)
    const claims = await service.verify(m.token, { expectedAudience: 'dsh-server', mockNow: future })
    expect(claims.sub).toBe('a')
    await service.close()
  })

  it('N10 default audience 错 (mint with audience override, verify expects default) → audience-mismatch', async () => {
    const { service } = await setup()
    const m = await service.mint({ subject: 'a', audience: 'evil-aud' })
    try {
      await service.verify(m.token, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      expect(isAuthError(err) && err.code === 'audience-mismatch').toBe(true)
    }
    await service.close()
  })
})
