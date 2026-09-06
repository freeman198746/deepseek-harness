/**
 * `@deepseek-ai/dsh-host-auth` — host-side token issuer / verifier.
 *
 * Mounts as `ctx.auth`; the {@link AuthService} signs and verifies
 * short-lived Ed25519 JWTs that identify a machine or user principal
 * to other packages in the same host process. The package does NOT
 * register HTTP routes, middleware, or session state — wiring
 * `Authorization: Bearer <token>` validation is the responsibility
 * of `@deepseek-ai/dsh-server` (the future `boot` step).
 *
 * The plugin has no runtime dependency on the database; mount it
 * anywhere in the registry after the operator-provided config is
 * resolved.
 *
 * @module @deepseek-ai/dsh-host-auth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { importJWK } from 'jose'
import { AuthService } from './service.ts'
import type { JsonWebKeyPair } from './types.ts'

/** Cordis plugin name. */
export const name = 'host-auth'

/**
 * No cross-plugin dependencies. Auth is the source of identity — every
 * other host-side plugin is a *consumer* of this one.
 */
export const inject: readonly string[] = []

/**
 * Plugin configuration. The plugin reads an asymmetric key pair plus
 * the issuer / audience policy from its `Config`. The key pair is
 * supplied by the operator at host bootstrap (see "Dev note" in
 * README.md for the recommended snippet).
 */
export interface HostAuthConfig {
  /** Asymmetric key pair (Ed25519 OKP JWK). */
  readonly keyPair: JsonWebKeyPair
  /** `iss` claim. */
  readonly issuer: string
  /** Default `aud` claim. */
  readonly audience: string
  /** Default TTL (seconds). Must be in `[1, 86400]`. */
  readonly tokenTtlSeconds?: number
  /** Clock skew tolerance (seconds). Must be in `[0, 300]`. */
  readonly clockSkewSeconds?: number
  /** Optional default subject. */
  readonly defaultSubject?: string
  /** Optional kid stamped on the protected header. */
  readonly keyId?: string
}

/**
 * Schemastery validator for {@link HostAuthConfig}. The JWK shape is
 * deliberately loose; structural validation is enforced by the runtime
 * `AuthService` constructor.
 */
export const Config: z<HostAuthConfig> = z.object({
  keyPair: z.object({
    privateKey: z.any(),
    publicKey: z.any(),
  }),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  // Range enforcement happens in the AuthService constructor (schemastery's
  // `.max()` does not chain into `.optional()` in this build; defaults match
  // the runtime AuthService defaults so validator paths stay aligned).
  tokenTtlSeconds: z.number().min(1).default(60 * 60),
  clockSkewSeconds: z.number().min(0).default(30),
  defaultSubject: z.string().min(1).required(false),
  keyId: z.string().min(1).required(false),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host-side token issuer / verifier. Mounted by `@deepseek-ai/dsh-host-auth`. */
    auth: AuthService
  }
}

/**
 * Mount the auth service on the cordis context.
 *
 * The `apply` hook returns a Promise; cordis awaits it before moving
 * on to dependent plugins (i.e. any plugin that injects `host-auth`
 * will run after the service is mounted). The async step is the
 * `jose.importJWK` resolution for both private and public keys.
 *
 * @param ctx - Cordis context.
 * @param config - Validated plugin configuration.
 * @returns Resolves once the CryptoKey pair is imported and the service is mounted.
 */
export async function apply(ctx: Context, config: HostAuthConfig): Promise<void> {
  const privateKey = await importJWK(
    config.keyPair.privateKey as unknown as Parameters<typeof importJWK>[0],
    'EdDSA',
  )
  const publicKey = await importJWK(
    config.keyPair.publicKey as unknown as Parameters<typeof importJWK>[0],
    'EdDSA',
  )
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey)) {
    throw new Error('host-auth: jose.importJWK returned non-CryptoKey (unsupported runtime)')
  }
  const service = new AuthService({
    keyPair: { privateKey, publicKey },
    issuer: config.issuer,
    audience: config.audience,
    tokenTtlSeconds: config.tokenTtlSeconds,
    clockSkewSeconds: config.clockSkewSeconds,
    defaultSubject: config.defaultSubject,
    keyId: config.keyId,
  })
  ctx.provide('auth', service)
  ctx.effect(() => async () => { await service.close() }, 'storage-postgres.close')
  // Note: the effect key is intentionally tied to the service lifecycle
  // rather than the plugin name so a future plugin rename stays a
  // single-file edit.
}

export { AuthService } from './service.ts'
export { AuthError, isAuthError, type AuthErrorCode } from './error.ts'
export type {
  AuthServiceOptions,
  CryptoKeyPair,
  HostAuthConfig as PublicHostAuthConfig,
  JsonWebKey,
  JsonWebKeyPair,
  MachineKeyId,
  MintedToken,
  MintOptions,
  ResolvedAuthConfig,
  TokenClaims,
  VerifyOptions,
} from './types.ts'
