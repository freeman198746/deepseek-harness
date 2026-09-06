/**
 * Errors thrown by the PostgreSQL storage backend. Distinct codes so the
 * controller layer can map them to HTTP / RPC statuses without parsing free
 * text.
 * @module @deepseek-ai/dsh-storage-postgres/src/error
 */

import type { StorageErrorCode } from './types.ts'

/** All error codes the package raises; callers branch on these. */
export type DshPostgresErrorCode =
  | StorageErrorCode
  | 'migration-failed'
  | 'pool-closed'
  | 'tenant-context-missing'

/**
 * Storage-postgres specific exception. Mirrors the storage-hub convention
 * (`StorageError`) where useful so generic storage handlers still recognise
 * `closed`, `version-mismatch`, and `malformed-medium`.
 * @param code - Machine-readable error code.
 * @param message - Human-readable message.
 * @param options - Underlying cause and extra context fields.
 */
export class DshPostgresError extends Error {
  readonly code: DshPostgresErrorCode

  constructor(code: DshPostgresErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DshPostgresError'
    this.code = code
  }
}