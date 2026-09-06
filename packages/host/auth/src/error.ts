/**
 * Error type for `@deepseek-ai/dsh-host-auth`.
 *
 * The error model is deliberately flat — a stable {@link AuthErrorCode}
 * on every instance lets callers branch on type without parsing the
 * message (which is for humans only). All codes correspond to a single
 * verifier step; the chain of `cause` is preserved for debugging.
 *
 * @module @deepseek-ai/dsh-host-auth
 */

/** Stable verifier / minter error categories. */
export type AuthErrorCode =
  /** Token compact form is not three base64url parts joined by dots. */
  | 'malformed-jwt'
  /** Signature did not validate against the configured key. */
  | 'signature-invalid'
  /** `exp` claim is in the past beyond the clock skew budget. */
  | 'expired'
  /** `nbf` claim is in the future beyond the clock skew budget. */
  | 'not-yet-valid'
  /** `iss` claim does not match the configured issuer. */
  | 'issuer-mismatch'
  /** `aud` claim does not match `expectedAudience`. */
  | 'audience-mismatch'
  /** Token is missing one or more required scopes. */
  | 'scope-missing'
  /** `kid` is not in the verifier's accepted kid list. */
  | 'unknown-key'
  /** Constructor argument failed runtime validation. */
  | 'invalid-config'

/**
 * Error thrown by `AuthService` operations. Carries a stable
 * {@link AuthErrorCode} and a human-readable message; nested jose errors
 * are exposed via `cause` for diagnostic logging.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
  }
}

/**
 * Type guard for `AuthError`. Useful for narrow `try/catch` sites that
 * also see non-Auth exceptions (e.g. config load failures).
 */
export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError
}
