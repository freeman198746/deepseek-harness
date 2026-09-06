/**
 * Error surface for the host-side reverse-lookup family.
 *
 * All errors thrown from the public API of this package are
 * {@link LookupError}. Codes are stable; consumers (HTTP handlers in
 * `@deepseek-ai/dsh-server`, AIMS-side mock stubs, scripts) may switch on
 * `error.code` without parsing messages.
 *
 * @module @deepseek-ai/dsh-host-lookup
 */

const BRAND = Symbol.for('@deepseek-ai/dsh-host-lookup/error')

/**
 * Stable error codes for the lookup family.
 *
 * - `invalid-biz-key` — the supplied `bizKey` does not match the
 *   `${prefix}.${host-id}` shape, or its prefix is not one of the three
 *   declared namespaces (`aims` / `patient` / `visit`).
 * - `unknown-lookup-type` — the supplied `type` is not one of
 *   `user` / `workspace` / `session`.
 * - `tenant-context-missing` — the caller invoked a lookup before the
 *   storage-postgres service had pinned `dsh.tenant`. This bubbles up from
 *   the underlying `withTenant` call and indicates a configuration mistake.
 * - `pool-closed` — the underlying pg.Pool has already been closed.
 * - `migration-failed` — a migration drift / apply failure was reported by
 *   storage-postgres and propagated here.
 * - `not-found` — the lookup family was asked to `ensure` a record that
 *   should have been created but the underlying INSERT returned no row,
 *   which would indicate a deeper race; rare enough to be an error.
 */
export type LookupErrorCode =
  | 'invalid-biz-key'
  | 'unknown-lookup-type'
  | 'tenant-context-missing'
  | 'pool-closed'
  | 'migration-failed'
  | 'not-found'

/**
 * Stable error class for everything thrown by `@deepseek-ai/dsh-host-lookup`.
 * Stores `code` for machine consumption and keeps the original `cause`
 * chain intact for diagnostics.
 */
export class LookupError extends Error {
  readonly code: LookupErrorCode
  /** Marker that disambiguates this error from `Error` subclasses elsewhere. */
  readonly [BRAND]: true

  constructor(code: LookupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LookupError'
    this.code = code
    this[BRAND] = true
  }
}