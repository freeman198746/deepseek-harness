/**
 * {@link AuthService} — host-side short-lived token issuer / verifier.
 *
 * Phase 1 ships a single asymmetric key pair (EdDSA / Ed25519). The
 * service signs with the private key and verifies with the public key;
 * signatures cross-check symmetrically because the verifier reads the
 * `alg` from the token header and dispatches to the matching JWK.
 *
 * Mint flow: build a claim set, sign with jose's `SignJWT` (EdDSA), and
 * return the compact form plus the generated `jti` / `exp`.
 *
 * Verify flow: parse with `jwtVerify`, validate `iss` / `aud` against
 * the configured values, confirm `nbf` / `exp` against the current
 * wall clock (with skew tolerance), and check that the required scopes
 * are a subset of the token's scopes.
 *
 * @module @deepseek-ai/dsh-host-auth
 */

import {
  SignJWT,
  errors as joseErrors,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose'
import { AuthError, type AuthErrorCode } from './error.ts'
import type {
  AuthServiceOptions,
  MintedToken,
  MintOptions,
  ResolvedAuthConfig,
  TokenClaims,
  VerifyOptions,
} from './types.ts'

/** Hard cap on clock skew — five minutes. Anything bigger is a config bug. */
const MAX_CLOCK_SKEW_SECONDS = 5 * 60

/** Hard floor on TTL — one second. */
const MIN_TTL_SECONDS = 1

/** Hard cap on TTL — one day (long enough for system jobs; anything longer should be signed COSE / opaque). */
const MAX_TTL_SECONDS = 24 * 60 * 60

/** Algorithm that this version signs with. Kept fixed because `kid` rotation is a future change. */
const SIGNING_ALGORITHM = 'EdDSA'

/**
 * Validate the constructor options. Throws `AuthError('invalid-config')`
 * for the first inconsistent argument.
 */
function assertConfig(options: AuthServiceOptions): void {
  if (typeof options.keyPair !== 'object' || options.keyPair === null) {
    throw new AuthError('invalid-config', 'keyPair must be an object')
  }
  if (!(options.keyPair.privateKey instanceof CryptoKey)) {
    throw new AuthError('invalid-config', 'privateKey must be a CryptoKey (resolve via jose importJWK)')
  }
  if (!(options.keyPair.publicKey instanceof CryptoKey)) {
    throw new AuthError('invalid-config', 'publicKey must be a CryptoKey (resolve via jose importJWK)')
  }
  const { issuer, audience, tokenTtlSeconds, clockSkewSeconds } = options
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new AuthError('invalid-config', 'issuer must be a non-empty string')
  }
  if (typeof audience !== 'string' || audience.length === 0) {
    throw new AuthError('invalid-config', 'audience must be a non-empty string')
  }
  if (tokenTtlSeconds !== undefined) {
    if (
      typeof tokenTtlSeconds !== 'number' ||
      !Number.isFinite(tokenTtlSeconds) ||
      tokenTtlSeconds < MIN_TTL_SECONDS ||
      tokenTtlSeconds > MAX_TTL_SECONDS
    ) {
      throw new AuthError(
        'invalid-config',
        `tokenTtlSeconds must be in [${MIN_TTL_SECONDS}, ${MAX_TTL_SECONDS}]`,
      )
    }
  }
  if (clockSkewSeconds !== undefined) {
    if (
      typeof clockSkewSeconds !== 'number' ||
      !Number.isFinite(clockSkewSeconds) ||
      clockSkewSeconds < 0 ||
      clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
    ) {
      throw new AuthError(
        'invalid-config',
        `clockSkewSeconds must be in [0, ${MAX_CLOCK_SKEW_SECONDS}]`,
      )
    }
  }
}

/** Generate a URL-safe random `jti` (16 bytes → 22 chars). */
function generateJti(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** URL-safe base64 encode without padding (RFC 7515 §2). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  const btoaFn = typeof btoa === 'function' ? btoa : null
  if (btoaFn) {
    return btoaFn(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }
  // Node fallback — global `Buffer` is always present in this runtime.
  return (Buffer as unknown as { from(b: string, e: 'binary'): { toString(e: 'base64'): string } })
    .from(binary, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

/**
 * Extracts the `iat / nbf / exp` timestamps from a jose-validated
 * payload, throwing when a required claim is missing.
 */
function extractNumericClaims(payload: JWTPayload): { iat: number; nbf: number; exp: number } {
  const iat = payload.iat
  const nbf = payload.nbf
  const exp = payload.exp
  if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number') {
    throw new AuthError(
      'malformed-jwt',
      'token must carry numeric iat, nbf, and exp claims',
    )
  }
  return { iat, nbf, exp }
}

/**
 * Convert a payload's `scopes` claim (jose keeps it as `unknown`) into a
 * readonly string array. Missing claim → empty array.
 */
function extractScopes(payload: JWTPayload): readonly string[] {
  const value = payload.scopes
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new AuthError('malformed-jwt', 'scopes claim must be an array of strings')
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new AuthError('malformed-jwt', 'scopes claim must contain only strings')
    }
  }
  return value as string[]
}

/**
 * Map a jose error class to an {@link AuthErrorCode}. Jose throws
 * specific subclasses (`JWTExpired`, `JWTClaimValidationFailed`, etc.);
 * we translate them into our own stable set.
 */
function translateJoseError(err: unknown): AuthError {
  if (err instanceof AuthError) return err
  if (err instanceof joseErrors.JWTExpired) {
    return new AuthError('expired', err.message, { cause: err })
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = err.claim
    const code: AuthErrorCode = claim === 'aud' ? 'audience-mismatch'
      : claim === 'iss' ? 'issuer-mismatch'
      : claim === 'nbf' ? 'not-yet-valid'
      : 'malformed-jwt'
    return new AuthError(code, err.message, { cause: err })
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AuthError('signature-invalid', err.message, { cause: err })
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return new AuthError('malformed-jwt', err.message, { cause: err })
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new AuthError('unknown-key', err.message, { cause: err })
  }
  return new AuthError('malformed-jwt', (err as Error)?.message ?? 'unknown verification failure', { cause: err })
}

/**
 * {@link AuthService} — signs and verifies short-lived asymmetric tokens.
 *
 * The service is constructed once at host boot; its key pair comes from
 * environment-driven config (a future `AuthConfigProvider` will rotate
 * the kid, but Phase 1 keeps a static key). The service is fully
 * synchronous on the JS event loop and never round-trips to the database.
 */
export class AuthService {
  readonly config: ResolvedAuthConfig

  private readonly privateCryptoKey: CryptoKey
  private readonly publicCryptoKey: CryptoKey
  private readonly issuer: string
  private readonly audience: string
  private readonly tokenTtlSeconds: number
  private readonly clockSkewSeconds: number
  private readonly defaultSubject: string | undefined
  private readonly keyId: string | undefined
  private closed = false

  constructor(options: AuthServiceOptions) {
    assertConfig(options)
    this.issuer = options.issuer
    this.audience = options.audience
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 60 * 60
    this.clockSkewSeconds = options.clockSkewSeconds ?? 30
    this.defaultSubject = options.defaultSubject
    this.keyId = options.keyId
    // keyPair validation passed in assertConfig; the explicit cast confines the
    // `unknown` shape of the public types to this one constructor site.
    this.privateCryptoKey = options.keyPair.privateKey as unknown as CryptoKey
    this.publicCryptoKey = options.keyPair.publicKey as unknown as CryptoKey
    this.config = Object.freeze({
      issuer: this.issuer,
      audience: this.audience,
      tokenTtlSeconds: this.tokenTtlSeconds,
      clockSkewSeconds: this.clockSkewSeconds,
      algorithm: SIGNING_ALGORITHM,
      defaultSubject: this.defaultSubject,
      keyId: this.keyId,
    })
  }

  /**
   * Mint a compact JWS using the configured Ed25519 key pair.
   *
   * @param options - Mint overrides (subject / audience / scopes / ttl / nbf / extras).
   * @returns A {@link MintedToken} carrying the wire form, jti, and expiry.
   */
  async mint(options: MintOptions = {}): Promise<MintedToken> {
    if (this.closed) {
      throw new AuthError('invalid-config', 'AuthService is closed')
    }
    const subject = options.subject ?? this.defaultSubject
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new AuthError('invalid-config', 'subject must be provided either in MintOptions or AuthServiceOptions.defaultSubject')
    }
    const audience = options.audience ?? this.audience
    const ttl = clampTtl(options.ttlSeconds ?? this.tokenTtlSeconds)
    const scopes = Array.isArray(options.scopes) ? [...options.scopes] : []
    const jti = generateJti()
    const nowSeconds = Math.floor((options.notBeforeOffsetSeconds
      ? Date.now() + options.notBeforeOffsetSeconds * 1000
      : Date.now()) / 1000)
    const exp = nowSeconds + ttl
    const nbf = nowSeconds
    const iat = nowSeconds

    const extras: Record<string, unknown> = options.extraClaims ? { ...options.extraClaims } : {}

    const payload: Record<string, unknown> = {
      iss: this.issuer,
      aud: audience,
      sub: subject,
      iat,
      nbf,
      exp,
      jti,
      scopes,
      ...extras,
    }

    let token: string
    try {
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: this.keyId, typ: 'JWT' })
      token = await jwt.sign(this.privateCryptoKey)
    } catch (err) {
      throw new AuthError('malformed-jwt', (err as Error)?.message ?? 'sign failed', { cause: err })
    }

    return {
      token,
      jti,
      expiresAt: new Date(exp * 1000),
      keyId: this.keyId,
    }
  }

  /**
   * Verify a compact JWS against the configured public key and call-site
   * invariants (audience, scopes, nbf/exp window).
   *
   * @param token - Wire form from `Authorization: Bearer <token>`.
   * @param options - Verifier invariants (`expectedAudience`, `requiredScopes`, `mockNow`).
   * @returns Verified {@link TokenClaims}.
   */
  async verify(token: string, options: VerifyOptions): Promise<TokenClaims> {
    if (this.closed) {
      throw new AuthError('invalid-config', 'AuthService is closed')
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new AuthError('malformed-jwt', 'token must be a non-empty string')
    }
    let result: JWTVerifyResult
    try {
      const opts = {
        audience: options.expectedAudience,
        issuer: this.issuer,
        clockTolerance: this.clockSkewSeconds,
        maxTokenAge: this.tokenTtlSeconds + this.clockSkewSeconds,
        currentDate: options.mockNow,
        algorithms: [SIGNING_ALGORITHM],
      }
      result = await jwtVerify(token, this.publicCryptoKey, opts)
    } catch (err) {
      throw translateJoseError(err)
    }
    const claims = result.payload
    const { iat, nbf, exp } = extractNumericClaims(claims)
    const scopes = extractScopes(claims)
    const extras = collectExtras(claims)
    const sub = claims.sub
    const iss = claims.iss
    const aud = claims.aud
    if (typeof sub !== 'string') {
      throw new AuthError('malformed-jwt', 'sub claim must be a string', { cause: claims })
    }
    if (typeof iss !== 'string') {
      throw new AuthError('malformed-jwt', 'iss claim must be a string', { cause: claims })
    }
    if (typeof aud !== 'string' && !Array.isArray(aud)) {
      throw new AuthError('malformed-jwt', 'aud claim must be a string or string[]')
    }
    const audValue = Array.isArray(aud) ? aud[0] ?? '' : aud
    if (typeof audValue !== 'string' || audValue !== options.expectedAudience) {
      throw new AuthError('audience-mismatch', `aud mismatch: expected ${options.expectedAudience}`)
    }
    if (iss !== this.issuer) {
      throw new AuthError('issuer-mismatch', `iss mismatch: expected ${this.issuer}`)
    }
    if (Array.isArray(aud) && !aud.includes(options.expectedAudience)) {
      throw new AuthError('audience-mismatch', `expectedAudience ${options.expectedAudience} not in aud array`)
    }
    // Scope subset check.
    if (options.requiredScopes && options.requiredScopes.length > 0) {
      const missing = options.requiredScopes.filter((s) => !scopes.includes(s))
      if (missing.length > 0) {
        throw new AuthError('scope-missing', `missing scopes: ${missing.join(', ')}`)
      }
    }
    return {
      iss,
      aud: audValue,
      sub,
      iat,
      nbf,
      exp,
      jti: typeof claims.jti === 'string' ? claims.jti : '',
      scopes,
      extras,
    }
  }

  /**
   * Refresh a token: re-mint with the same subject / audience / extras
   * but a fresh `iat / nbf / exp / jti`. The existing `jti` is recorded
   * as `aud` claim `audience` for tracing. The operation verifies the
   * incoming token first to ensure callers are presenting a valid one.
   */
  async rotate(token: string, options: VerifyOptions & Pick<MintOptions, 'ttlSeconds' | 'scopes'> = {
    expectedAudience: '',
  }): Promise<MintedToken> {
    const claims = await this.verify(token, options)
    const next = await this.mint({
      subject: claims.sub,
      audience: claims.aud,
      scopes: options.scopes ?? claims.scopes,
      ttlSeconds: options.ttlSeconds ?? this.tokenTtlSeconds,
      extraClaims: claims.extras,
    })
    return next
  }

  /**
   * Release any internal resources. Phase 1 has no async resources; the
   * method exists for symmetry with other host-side services so future
   * key rotation can hook into the dispose path.
   */
  async close(): Promise<void> {
    this.closed = true
  }
}

/** Clamp a TTL into the configured bounds. */
function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl < MIN_TTL_SECONDS) return MIN_TTL_SECONDS
  if (ttl > MAX_TTL_SECONDS) return MAX_TTL_SECONDS
  return Math.floor(ttl)
}

/** Collect non-standard extra claims into a readonly record. */
function collectExtras(claims: JWTPayload): Readonly<Record<string, unknown>> {
  const standard = new Set(['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'scopes'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(claims)) {
    if (!standard.has(k)) {
      out[k] = v
    }
  }
  return out
}

