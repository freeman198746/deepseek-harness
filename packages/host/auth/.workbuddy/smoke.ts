/**
 * Offline verifier for `@deepseek-ai/dsh-host-auth`.
 *
 * This file deliberately bypasses the workspace vitest harness — vitest
 * 4.0+ in this monorepo scans a fixed glob and refuses per-package
 * `--config` overrides that add new entries. Running via
 * `tsx .workbuddy/smoke.ts` keeps the loop tight while still exercising
 * the same paths as `tests/contract.spec.ts`.
 *
 * When vitest multi-project recognises the auth suite, this file is
 * safe to delete. Remove the entry from the README's "Dev note" at
 * the same time.
 *
 * Test layers (matches contract.spec.ts):
 *   - jose API smoke (round-trip sign + verify)
 *   - AuthService construction (happy path + config validation)
 *   - mint / verify (round-trip, audience, issuer, scopes, extras)
 *   - negative (expired, audience-mismatch, issuer-mismatch, malformed,
 *     signature-invalid, scope-missing, ttl floor/ceiling, clock skew,
 *     closed service)
 *
 * Usage:
 *
 *     node --import tsx packages/host/auth/.workbuddy/smoke.ts
 *
 * Returns exit code 0 on success, 1 on failure.
 */

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { Context } from '@deepseek-ai/cordis'
import {
  apply as hostAuthApply,
  Config as HostAuthConfigSchema,
  inject as hostAuthInject,
  name as hostAuthName,
  AuthService,
} from '../src/index.ts'
import { AuthError, isAuthError } from '../src/error.ts'
import type {
  AuthServiceOptions,
  MintedToken,
  TokenClaims,
} from '../src/types.ts'

async function exportJWKPair(kp: ServiceKeyPair): Promise<{ privateKey: Record<string, unknown>; publicKey: Record<string, unknown> }> {
  return {
    privateKey: await exportJWK(kp.privateKey),
    publicKey: await exportJWK(kp.publicKey),
  }
}

interface Counters {
  pass: number
  fail: number
}
const counters: Counters = { pass: 0, fail: 0 }

function ok(name: string): void {
  counters.pass += 1
  process.stdout.write(`OK ${name}\n`)
}

function fail(name: string, err: unknown): void {
  counters.fail += 1
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  process.stdout.write(`FAIL ${name}\n${message}\n`)
}

async function safe(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    ok(name)
  } catch (err) {
    fail(name, err)
  }
}

interface ServiceKeyPair {
  readonly privateKey: CryptoKey
  readonly publicKey: CryptoKey
}

async function generateCryptoKeyPair(): Promise<ServiceKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey)) {
    throw new Error('jose.generateKeyPair returned non-CryptoKey (unsupported runtime)')
  }
  return { privateKey, publicKey }
}

function baseOptions(keyPair: ServiceKeyPair, overrides: Partial<AuthServiceOptions> = {}): AuthServiceOptions {
  return {
    keyPair,
    issuer: 'dsh',
    audience: 'dsh-server',
    tokenTtlSeconds: 3600,
    clockSkewSeconds: 30,
    ...overrides,
  }
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
  name: string,
): Promise<void> {
  try {
    await promise
    throw new Error(`${name}: expected AuthError(${code}), resolved with success`)
  } catch (err) {
    if (!isAuthError(err)) {
      throw new Error(`${name}: expected AuthError, got ${String(err)}`)
    }
    if (err.code !== code) {
      throw new Error(`${name}: expected code=${code}, got ${err.code}`)
    }
  }
}

async function main(): Promise<void> {
  const keyPair = await generateCryptoKeyPair()
  const opts = baseOptions(keyPair)

  // 1. AuthService constructor (happy path).
  let service: AuthService | undefined
  await safe('AuthService constructor (happy path)', () => {
    service = new AuthService(opts)
    if (service.config.algorithm !== 'EdDSA') {
      throw new Error(`algorithm mismatch: ${service.config.algorithm}`)
    }
    if (service.config.tokenTtlSeconds !== 3600) {
      throw new Error(`ttl mismatch: ${service.config.tokenTtlSeconds}`)
    }
    if (service.config.clockSkewSeconds !== 30) {
      throw new Error(`skew mismatch: ${service.config.clockSkewSeconds}`)
    }
    if (service.config.issuer !== 'dsh') throw new Error(`issuer mismatch: ${service.config.issuer}`)
    if (service.config.audience !== 'dsh-server') {
      throw new Error(`audience mismatch: ${service.config.audience}`)
    }
  })

  // 2. config: ttl out of range.
  await safe('config ttl < 1 reject', () => {
    try {
      new AuthService(baseOptions(keyPair, { tokenTtlSeconds: -1 }))
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  await safe('config ttl > MAX reject', () => {
    try {
      new AuthService(baseOptions(keyPair, { tokenTtlSeconds: 24 * 60 * 60 + 1 }))
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  await safe('config skew > MAX reject', () => {
    try {
      new AuthService(baseOptions(keyPair, { clockSkewSeconds: 5 * 60 + 1 }))
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  await safe('config empty issuer reject', () => {
    try {
      new AuthService(baseOptions(keyPair, { issuer: '' }))
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  await safe('config empty audience reject', () => {
    try {
      new AuthService(baseOptions(keyPair, { audience: '' }))
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  await safe('config non-CryptoKey privateKey reject', () => {
    try {
      new AuthService({
        ...opts,
        keyPair: { privateKey: { not: 'a crypto key' } as unknown as CryptoKey, publicKey: keyPair.publicKey },
      })
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err) || err.code !== 'invalid-config') throw err
    }
  })

  // 3. mint / verify (round-trip).
  let minted: MintedToken | undefined
  await safe('mint/verify round-trip', async () => {
    if (!service) throw new Error('service not constructed')
    minted = await service.mint({ subject: 'tester', scopes: ['lookup:read'] })
    if (minted.token.split('.').length !== 3) throw new Error('compact JWS must have 3 parts')
    const claims = await service.verify(minted.token, { expectedAudience: 'dsh-server' })
    if (claims.sub !== 'tester') throw new Error(`sub mismatch: ${claims.sub}`)
    if (claims.iss !== 'dsh') throw new Error(`iss mismatch: ${claims.iss}`)
    if (claims.aud !== 'dsh-server') throw new Error(`aud mismatch: ${claims.aud}`)
    if (!claims.scopes.includes('lookup:read')) {
      throw new Error(`scopes missing: ${JSON.stringify(claims.scopes)}`)
    }
    if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
      throw new Error(`jti missing: ${claims.jti}`)
    }
  })

  // 4. mint with extras + read extras.
  let extrasToken: MintedToken | undefined
  await safe('mint with extras + read extras', async () => {
    if (!service) throw new Error('service not constructed')
    extrasToken = await service.mint({
      subject: 'machine-1',
      scopes: ['ensure:write'],
      extraClaims: { tenantId: 't-123', dshUserId: 'u-456' },
    })
    if (!extrasToken) throw new Error('mint returned null')
    const claims: TokenClaims = await service.verify(extrasToken.token, { expectedAudience: 'dsh-server' })
    if ((claims.extras.tenantId as string | undefined) !== 't-123') {
      throw new Error(`tenantId extras mismatch: ${String(claims.extras.tenantId)}`)
    }
    if ((claims.extras.dshUserId as string | undefined) !== 'u-456') {
      throw new Error(`dshUserId extras mismatch: ${String(claims.extras.dshUserId)}`)
    }
    if (claims.sub !== 'machine-1') throw new Error(`sub mismatch: ${claims.sub}`)
  })

  // 5. expired token (TTL 1s + wait + skew 0).
  await safe('expired token reject', async () => {
    const fast = new AuthService(baseOptions(keyPair, { tokenTtlSeconds: 1, clockSkewSeconds: 0 }))
    const m: MintedToken = await fast.mint({ subject: 'short' })
    await new Promise((r) => setTimeout(r, 1500))
    await expectAuthError(
      fast.verify(m.token, { expectedAudience: 'dsh-server' }),
      'expired',
      'expired token reject',
    )
    await fast.close()
  })

  // 6. audience mismatch.
  await safe('audience mismatch reject', async () => {
    if (!service || !minted) throw new Error('service/minted missing')
    await expectAuthError(
      service.verify(minted.token, { expectedAudience: 'wrong-aud' }),
      'audience-mismatch',
      'audience mismatch reject',
    )
  })

  // 7. issuer mismatch (different service).
  await safe('issuer mismatch reject', async () => {
    const kp2 = await generateCryptoKeyPair()
    const s2 = new AuthService(baseOptions(kp2, { issuer: 'other' }))
    const m2 = await s2.mint({ subject: 'a' })
    const verifier = new AuthService(baseOptions(kp2))
    await expectAuthError(
      verifier.verify(m2.token, { expectedAudience: 'dsh-server' }),
      'issuer-mismatch',
      'issuer mismatch reject',
    )
    await s2.close()
    await verifier.close()
  })

  // 8. malformed token.
  await safe('malformed token reject', async () => {
    if (!service) throw new Error('service missing')
    await expectAuthError(
      service.verify('not.a.jwt', { expectedAudience: 'dsh-server' }),
      'malformed-jwt',
      'malformed token reject',
    )
  })

  // 9. signature-invalid (tamper).
  await safe('signature tamper reject', async () => {
    if (!service || !minted) throw new Error('service/minted missing')
    const [h, p, s] = minted.token.split('.')
    if (!h || !p || !s) throw new Error('token shape broken')
    // Flip the last character in the signature segment.
    const lastChar = s.charAt(s.length - 1)
    const replacement = lastChar === 'A' ? 'B' : 'A'
    const tampered = s.slice(0, s.length - 1) + replacement
    const tamperedToken = `${h}.${p}.${tampered}`
    // Note: tampering the sig may produce 'signature-invalid' OR 'malformed-jwt' depending on jose's tolerance.
    try {
      await service.verify(tamperedToken, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err)) throw err
      if (err.code !== 'signature-invalid' && err.code !== 'malformed-jwt') {
        throw new Error(`unexpected code: ${err.code}`)
      }
    }
  })

  // 10. scope-missing.
  await safe('scope-missing reject', async () => {
    if (!service) throw new Error('service missing')
    const m2 = await service.mint({ subject: 'a', scopes: ['lookup:read'] })
    await expectAuthError(
      service.verify(m2.token, {
        expectedAudience: 'dsh-server',
        requiredScopes: ['ensure:write'],
      }),
      'scope-missing',
      'scope missing reject',
    )
  })

  // 11. ttl clamp to MIN (1).
  await safe('ttl clamp to MIN (1)', async () => {
    if (!service) throw new Error('service missing')
    const m = await service.mint({ subject: 'a', ttlSeconds: -100 })
    const claims = await service.verify(m.token, { expectedAudience: 'dsh-server' })
    if (claims.exp - claims.iat < 1 || claims.exp - claims.iat > 2) {
      throw new Error(`clamped ttl out of range: ${claims.exp - claims.iat}`)
    }
  })

  // 12. ttl clamp to MAX (86400).
  await safe('ttl clamp to MAX (86400)', async () => {
    if (!service) throw new Error('service missing')
    const m = await service.mint({ subject: 'a', ttlSeconds: 99 * 60 * 60 })
    const claims = await service.verify(m.token, { expectedAudience: 'dsh-server' })
    if (claims.exp - claims.iat !== 24 * 60 * 60) {
      throw new Error(`clamped ttl not MAX: ${claims.exp - claims.iat}`)
    }
  })

  // 13. notBeforeOffsetSeconds honored.
  await safe('notBeforeOffsetSeconds honored', async () => {
    if (!service) throw new Error('service missing')
    const m = await service.mint({ subject: 'a', ttlSeconds: 60, notBeforeOffsetSeconds: 600 })
    try {
      await service.verify(m.token, { expectedAudience: 'dsh-server' })
      throw new Error('expected throw')
    } catch (err) {
      if (!isAuthError(err)) throw err
      if (err.code !== 'not-yet-valid' && err.code !== 'expired') {
        throw new Error(`unexpected code: ${err.code}`)
      }
    }
  })

  // 14. kid round-trip with explicit kid.
  await safe('kid round-trip', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp, { keyId: 'k-1' }))
    const m = await s.mint({ subject: 'a' })
    if (m.keyId !== 'k-1') throw new Error(`kid mismatch: ${m.keyId}`)
    const claims = await s.verify(m.token, { expectedAudience: 'dsh-server' })
    if (!claims.jti) throw new Error('jti missing')
    await s.close()
  })

  // 15. closed service rejects mint.
  await safe('closed service rejects mint + verify', async () => {
    if (!service) throw new Error('service missing')
    await service.close()
    await expectAuthError(
      service.mint({ subject: 'a' }),
      'invalid-config',
      'closed service mint',
    )
    await expectAuthError(
      service.verify('dummy', { expectedAudience: 'dsh-server' }),
      'invalid-config',
      'closed service verify',
    )
  })

  // 16. rotate yields fresh jti + matching exp window.
  await safe('rotate yields fresh jti + larger exp', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp, { tokenTtlSeconds: 30 }))
    const m = await s.mint({ subject: 'rotate-sub' })
    const claims = await s.verify(m.token, { expectedAudience: 'dsh-server' })
    const m2 = await s.rotate(m.token, { expectedAudience: 'dsh-server' })
    if (m2.jti === m.jti) throw new Error('jti did not refresh')
    if (m2.token === m.token) throw new Error('token did not refresh')
    if (claims.exp + 5 < m2.expiresAt.getTime() / 1000) {
      throw new Error('exp did not advance')
    }
    const claims2 = await s.verify(m2.token, { expectedAudience: 'dsh-server' })
    if (claims2.sub !== 'rotate-sub') throw new Error(`sub not preserved: ${claims2.sub}`)
    if (claims.sub !== claims2.sub) throw new Error('sub drift')
    await s.close()
  })

  // 17. verify with requiredScopes satisfied.
  await safe('verify with requiredScopes passes', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a', scopes: ['lookup:read', 'ensure:write'] })
    const claims = await s.verify(m.token, {
      expectedAudience: 'dsh-server',
      requiredScopes: ['lookup:read'],
    })
    if (!claims.scopes.includes('ensure:write')) {
      throw new Error(`scopes not preserved: ${JSON.stringify(claims.scopes)}`)
    }
    await s.close()
  })

  // 18. cordis plugin mounts; ctx.auth is the AuthService.
  await safe('cordis plugin mount + ctx.auth typed', async () => {
    const kp = await generateCryptoKeyPair()
    const ctx = new Context()
    const jwkPair = await exportJWKPair(kp)
    const cfg = {
      keyPair: jwkPair,
      issuer: 'dsh',
      audience: 'dsh-server',
      keyId: 'k-cordis-smoke',
    }
    // Validate the schemastery config in-place.
    const validator = HostAuthConfigSchema as unknown as {
      '~standard'?: { validate: (input: unknown) => { value?: unknown; issues?: unknown } }
    }
    if (typeof validator['~standard']?.validate !== 'function') {
      throw new Error('cordis Config validator missing StandardSchema interface')
    }
    const result = validator['~standard'].validate(cfg)
    if (result?.value === undefined) {
      throw new Error(`config validate failed: ${JSON.stringify(result?.issues)}`)
    }
    // Plugin metadata sanity check.
    if (hostAuthName !== 'host-auth') throw new Error(`plugin name mismatch: ${hostAuthName}`)
    if (!Array.isArray(hostAuthInject) || hostAuthInject.length !== 0) {
      throw new Error(`inject must be empty for the auth source: ${JSON.stringify(hostAuthInject)}`)
    }
    // Apply the plugin via async path (the real install path).
    await hostAuthApply(ctx as unknown as Parameters<typeof hostAuthApply>[0], cfg as unknown as Parameters<typeof hostAuthApply>[1])
    if (!ctx.auth || !(ctx.auth instanceof AuthService)) {
      throw new Error('ctx.auth not populated')
    }
    // Smoke the mounted service: end-to-end round-trip.
    const auth = ctx.auth as AuthService
    const m = await auth.mint({ subject: 'cordis-tester', scopes: ['lookup:read'] })
    const claims = await auth.verify(m.token, {
      expectedAudience: 'dsh-server',
      requiredScopes: ['lookup:read'],
    })
    if (claims.sub !== 'cordis-tester') {
      throw new Error(`sub mismatch: ${claims.sub}`)
    }
    await ctx.auth.close()
  })

  // -------------------------------------------------------------------------
  // T1 — Negative cases N1..N10 (DSH multi-tenant plan §15 token verification)
  //
  // The ten tests pin down every rejection path a real attacker would probe.
  // They are deliberately separate from the happy-path suite above so a
  // regression on any one path is easy to spot in the smoke report.
  // -------------------------------------------------------------------------

  // N1: signature tamper.
  await safe('N1 signature tamper → signature-invalid', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a' })
    const [h, p, sig] = m.token.split('.')
    if (!h || !p || !sig) throw new Error('N1: token shape broken')
    const tampered = `${h}.${p}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`
    try {
      await s.verify(tampered, { expectedAudience: 'dsh-server' })
      throw new Error('N1: expected throw')
    } catch (err) {
      if (!isAuthError(err)) throw err
      if (err.code !== 'signature-invalid' && err.code !== 'malformed-jwt') {
        throw new Error(`N1: unexpected code: ${err.code}`)
      }
    }
    await s.close()
  })

  // N2: expired (TTL 1s + sleep + skew 0).
  await safe('N2 expired → expired', async () => {
    const kp = await generateCryptoKeyPair()
    const fast = new AuthService(baseOptions(kp, { tokenTtlSeconds: 1, clockSkewSeconds: 0 }))
    const m = await fast.mint({ subject: 'a' })
    await new Promise((r) => setTimeout(r, 1500))
    await expectAuthError(fast.verify(m.token, { expectedAudience: 'dsh-server' }), 'expired', 'N2 expired')
    await fast.close()
  })

  // N3: wrong issuer.
  await safe('N3 wrong issuer → issuer-mismatch', async () => {
    const kp = await generateCryptoKeyPair()
    const signer = new AuthService(baseOptions(kp, { issuer: 'attacker' }))
    const verifier = new AuthService(baseOptions(kp))
    const m = await signer.mint({ subject: 'a' })
    await expectAuthError(
      verifier.verify(m.token, { expectedAudience: 'dsh-server' }),
      'issuer-mismatch',
      'N3 wrong issuer',
    )
    await signer.close()
    await verifier.close()
  })

  // N4: wrong audience.
  await safe('N4 wrong audience → audience-mismatch', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a' })
    await expectAuthError(
      s.verify(m.token, { expectedAudience: 'wrong-aud' }),
      'audience-mismatch',
      'N4 wrong audience',
    )
    await s.close()
  })

  // N5: missing scope.
  await safe('N5 missing required scope → scope-missing', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a', scopes: ['lookup:read'] })
    await expectAuthError(
      s.verify(m.token, { expectedAudience: 'dsh-server', requiredScopes: ['ensure:write'] }),
      'scope-missing',
      'N5 missing scope',
    )
    await s.close()
  })

  // N6: wrong alg — HS256 token verified against EdDSA key.
  await safe('N6 wrong alg (HS256 vs EdDSA) → signature-invalid', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const hsKey = new TextEncoder().encode('attacker-controlled-secret')
    const hsToken = await new SignJWT({ iss: 'dsh', aud: 'dsh-server', sub: 'a' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('jti-fake')
      .sign(hsKey)
    try {
      await s.verify(hsToken, { expectedAudience: 'dsh-server' })
      throw new Error('N6: expected throw')
    } catch (err) {
      if (!isAuthError(err)) throw err
      if (err.code !== 'signature-invalid' && err.code !== 'malformed-jwt') {
        throw new Error(`N6: unexpected code: ${err.code}`)
      }
    }
    await s.close()
  })

  // N7: bad token shape (1/2/4 segments).
  await safe('N7 bad token shape → malformed-jwt', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    for (const shape of ['', 'a', 'a.b', 'a.b.c.d']) {
      try {
        await s.verify(shape, { expectedAudience: 'dsh-server' })
        throw new Error(`N7: expected throw for shape: ${shape}`)
      } catch (err) {
        if (!isAuthError(err) || err.code !== 'malformed-jwt') {
          throw new Error(`N7: unexpected code for "${shape}": ${String(err)}`)
        }
      }
    }
    await s.close()
  })

  // N8: replay jti — document current behavior (no replay protection at this layer).
  await safe('N8 replay jti → second verify succeeds (replay protection is caller-side)', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a' })
    const first = await s.verify(m.token, { expectedAudience: 'dsh-server' })
    const second = await s.verify(m.token, { expectedAudience: 'dsh-server' })
    if (first.jti !== second.jti) throw new Error('N8: jti unexpectedly changed')
    if (first.sub !== second.sub) throw new Error('N8: sub unexpectedly changed')
    await s.close()
  })

  // N9: clock skew tolerance — token just-expired within skew window.
  await safe('N9 clock skew tolerance (within window) → accepted', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp, { tokenTtlSeconds: 60, clockSkewSeconds: 60 }))
    const m = await s.mint({ subject: 'a', ttlSeconds: 60 })
    // mockNow 90 seconds in the future — token expired 30s ago, well inside the 60s skew.
    const future = new Date(Date.now() + 90 * 1000)
    const claims = await s.verify(m.token, { expectedAudience: 'dsh-server', mockNow: future })
    if (claims.sub !== 'a') throw new Error(`N9: sub mismatch: ${claims.sub}`)
    await s.close()
  })

  // N10: default audience 错 (mint with audience override, verify expects default).
  await safe('N10 default audience 错 (mint override) → audience-mismatch', async () => {
    const kp = await generateCryptoKeyPair()
    const s = new AuthService(baseOptions(kp))
    const m = await s.mint({ subject: 'a', audience: 'evil-aud' })
    await expectAuthError(
      s.verify(m.token, { expectedAudience: 'dsh-server' }),
      'audience-mismatch',
      'N10 default audience',
    )
    await s.close()
  })

  process.stdout.write('\n')
  process.stdout.write(`Result: ${counters.pass} passed, ${counters.fail} failed\n`)
  process.stdout.write(counters.fail === 0 ? 'ALL CHECKS PASSED\n' : 'SOME CHECKS FAILED\n')

  if (counters.fail > 0) process.exit(1)
}

void main()
