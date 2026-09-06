/**
 * Public type surface for the PostgreSQL storage backend. Branded opaque
 * ids keep cross-boundary values type-safe (`TenantId` ≠ `UserId` even when
 * both are UUID strings). Storage error codes mirror the storage-hub
 * vocabulary so the hub's existing dispatchers keep working.
 * @module @deepseek-ai/dsh-storage-postgres/src/types
 */

/** Nominal brand for an opaque identifier string. */
declare const BRAND: unique symbol

/** A branded string. The `T` phantom keeps each brand distinct at the type level. */
export type Branded<T extends string> = string & { readonly [BRAND]: T }

/** Tenant id (a hospital in the multi-tenant plan). */
export type TenantId = Branded<'TenantId'>

/** App-user id (a doctor / staff member inside one tenant). */
export type UserId = Branded<'UserId'>

/** Workspace id. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Session id. */
export type SessionId = Branded<'SessionId'>

/**
 * Storage error codes the backend reuses from the storage hub. The hub's own
 * `StorageError` defines these; mirrored here so this package can throw them
 * without taking a runtime dependency on the hub.
 */
export type StorageErrorCode =
  | 'closed'
  | 'version-mismatch'
  | 'malformed-medium'

/**
 * A migration record: file name (including numeric prefix) plus the SQL body.
 * The plugin loader sorts these by file name before applying, so authors
 * must keep the numeric prefix monotonic.
 */
export interface Migration {
  readonly file: string
  readonly sql: string
}

/**
 * Result of an apply-migrations run: which files were applied this run, which
 * were already on disk, and any recorded checksum for drift detection.
 */
export interface MigrationResult {
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
  readonly recorded: ReadonlyMap<string, string>
}

/**
 * Per-request tenant + user context. Callers pass this to {@link PgClient.withTenant}
 * to wrap every database call with `SET LOCAL dsh.tenant` / `dsh.uid`.
 * `traceId` becomes `dsh.trace_id` for audit-log fan-out.
 */
export interface TenantContext {
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly traceId?: string
}