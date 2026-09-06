/**
 * Type definitions for `@deepseek-ai/dsh-host-auth`.
 *
 * The host-auth package issues short-lived JWTs that prove a machine or
 * user identity to other packages in the same host process. The tokens
 * follow RFC 7519 (JWS compact) with a deterministic claim set so a
 * verifier can reconstruct the tenant / user context without an extra
 * database round-trip.
 *
 * Every token carries the following claims:
 *
 *   iss      - issuer literal (default `dsh`)
 *   aud      - audience literal (callable token verifies against this)
 *   sub      - subject principal name (`{tenantId}.{userId}` for users,
 *              `{machineKeyId}` for machines, `system` for system jobs)
 *   iat/nbf  - issued at / not before
 *   exp      - expiry (iat + tokenTtlSeconds)
 *   jti      - unique token id (random 16-byte URL-safe base64)
 *   scopes   - array of action scopes (e.g. `lookup:read`, `ensure:write`)
 *
 * @module @deepseek-ai/dsh-host-auth
 */

/**
 * Branded id for machine keys. Issued by an operator ahead of time and
 * referenced from server bootstrap; distinct from {@link TenantId} and
 * {@link UserId} so a key id collision surface is documented.
 */
export type MachineKeyId = string & { readonly [MachineKeyIdBrand]: true }
declare const MachineKeyIdBrand: unique symbol

/** Helper for tests + trusted callers. Throws on empty / non-string. */
export function asMachineKeyId(value: string): MachineKeyId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('MachineKeyId must be a non-empty string')
  }
  return value as MachineKeyId
}

/**
 * JSON Web Key (RFC 7517). The host-auth service accepts a single
 * asymmetric key pair at construction; multi-key rotation is out of
 * scope for Phase 1 (a future `AuthService.rotate()` will introduce it
 * with a `kid` lookup table).
 */
export interface JsonWebKeyPair {
  /** JWK private key (must include `kid`). */
  readonly privateKey: JsonWebKey
  /** JWK public key. */
  readonly publicKey: JsonWebKey
}

/**
 * A JSON Web Key as exposed by `jose` (loose typing here is intentional
 * — jose keeps the wire format identical to the RFC).
 */
export interface JsonWebKey {
  readonly kty?: string
  readonly alg?: string
  readonly kid?: string
  readonly crv?: string
  readonly x?: string
  readonly d?: string
  readonly [extension: string]: unknown
}

/**
 * Imported asymmetric CryptoKey pair. The JWK pair (above) is the wire
 * shape callers typically persist; the runtime uses the imported
 * CryptoKey pair to avoid re-running `jose.importJWK` on every sign /
 * verify. Resolving a JWK pair into a CryptoKey pair is the
 * `importJWK` step in the registry apply hook.
 */
export interface CryptoKeyPair {
  /** Web Crypto `CryptoKey` for EdDSA signing. */
  readonly privateKey: unknown
  /** Web Crypto `CryptoKey` for EdDSA verification. */
  readonly publicKey: unknown
}

/** Result of a successful mint. The token is the wire form returned to callers. */
export interface MintedToken {
  /** Compact JWS, ready to be passed as `Authorization: Bearer <token>`. */
  readonly token: string
  /** Token id (the `jti` claim). Persisted for revocation audits. */
  readonly jti: string
  /** Expiry as a Date (the `exp` claim, in UTC). */
  readonly expiresAt: Date
  /** Optional kid for downstream key dispatch (currently equals the configured kid). */
  readonly keyId: string | undefined
}

/**
 * Parameters for {@link AuthService.mint}. The subject is opaque to the
 * issuer — callers decide whether it is a user principal, a machine
 * key, or a `system` token.
 */
export interface MintOptions {
  /** Optional subject override (otherwise the service's `subject` option is used). */
  readonly subject?: string
  /** Optional audience override (otherwise the service's `audience` is used). */
  readonly audience?: string
  /** Optional scope list; absent → no scopes (token is identity-only). */
  readonly scopes?: readonly string[]
  /** Optional TTL override (seconds). Must be > 0; otherwise the service default applies. */
  readonly ttlSeconds?: number
  /** Optional `nbf` offset (seconds from now). Defaults to 0. */
  readonly notBeforeOffsetSeconds?: number
  /**
   * Optional extra claims merged in (read-only verification, e.g.
   * tenant id). Merging is shallow — collisions reject.
   */
  readonly extraClaims?: Readonly<Record<string, unknown>>
}

/** Parameters for {@link AuthService.verify}. */
export interface VerifyOptions {
  /** Required audience; mismatches throw `AuthError('audience-mismatch')`. */
  readonly expectedAudience: string
  /** Optional required scopes (subset match); missing scopes throw `AuthError('scope-missing')`. */
  readonly requiredScopes?: readonly string[]
  /**
   * Current time override (test-only). The verifier normally reads
   * `Date.now()`; tests pass `mockNow` to fast-forward / rewind.
   */
  readonly mockNow?: Date
}

/**
 * Claims extracted from a verified token. All numeric claims are
 * expressed as absolute Unix-epoch seconds.
 */
export interface TokenClaims {
  /** Issuer claim. */
  readonly iss: string
  /** Audience claim (string for now; could be array in future). */
  readonly aud: string
  /** Subject (whatever the minter chose). */
  readonly sub: string
  /** Issued at (Unix seconds). */
  readonly iat: number
  /** Not-before (Unix seconds). */
  readonly nbf: number
  /** Expires at (Unix seconds). */
  readonly exp: number
  /** Token id (the `jti` claim). */
  readonly jti: string
  /** Optional scope list (always an array; empty array if absent). */
  readonly scopes: readonly string[]
  /**
   * Any extra claims merged in at mint time. Read-only. Reserved for
   * the multi-tenant pipeline (e.g. `tenantId`).
   */
  readonly extras: Readonly<Record<string, unknown>>
}

/** Options accepted by {@link AuthService}. The key pair is the imported CryptoKey form. */
export interface AuthServiceOptions {
  /** Imported asymmetric key pair (resolve via `jose.importJWK`). */
  readonly keyPair: CryptoKeyPair
  /** Issuer literal stamped into every minted token (`iss` claim). */
  readonly issuer: string
  /** Default audience stamped into every minted token (`aud` claim). */
  readonly audience: string
  /** Default TTL (seconds) for minted tokens. Must be > 0. */
  readonly tokenTtlSeconds?: number
  /**
   * Clock skew tolerance (seconds) when comparing `nbf` / `exp`.
   * Default `30` seconds; absolute upper bound `5 * 60`.
   */
  readonly clockSkewSeconds?: number
  /**
   * Optional default subject stamped when the minter omits `subject`.
   * Typical values: `system` (background jobs) or a service name.
   */
  readonly defaultSubject?: string
  /** Key id (`kid`) stamped on the protected header. Optional. */
  readonly keyId?: string
}

/** A resolved config — defaults applied — for inspection / logs. */
export interface ResolvedAuthConfig {
  readonly issuer: string
  readonly audience: string
  readonly tokenTtlSeconds: number
  readonly clockSkewSeconds: number
  readonly algorithm: string
  readonly defaultSubject: string | undefined
  readonly keyId: string | undefined
}
