/**
 * {@link ServerError} — the typed error class used by every handler in
 * `@deepseek-ai/dsh-host-server`. The `code` field is the machine-readable
 * value the HTTP layer uses to pick a status; the `message` is for logs
 * and for the JSON response body.
 *
 * @module @deepseek-ai/dsh-host-server
 */

/** The set of stable server error codes exposed to API clients. */
export type ServerErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'conflict'
  | 'upstream-unavailable'
  | 'internal-error'

/** A typed server error carrying a stable code. */
export class ServerError extends Error {
  readonly code: ServerErrorCode
  readonly httpStatus: number

  constructor(code: ServerErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message)
    this.name = 'ServerError'
    this.code = code
    this.httpStatus = ServerError.statusFor(code)
    if (options?.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }

  /**
   * Map a stable {@link ServerErrorCode} to its HTTP status.
   *
   * @param code - Error code.
   * @returns The matching HTTP status code (always >= 400).
   */
  static statusFor(code: ServerErrorCode): number {
    switch (code) {
      case 'unauthenticated': return 401
      case 'forbidden': return 403
      case 'not-found': return 404
      case 'bad-request': return 400
      case 'conflict': return 409
      case 'upstream-unavailable': return 503
      case 'internal-error': return 500
    }
  }
}

/** Runtime type guard for {@link ServerError}. */
export function isServerError(value: unknown): value is ServerError {
  return value instanceof ServerError
}
