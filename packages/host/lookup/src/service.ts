/**
 * {@link LookupService} — host-side reverse-lookup and ensure orchestrator.
 *
 * The service is a thin wrapper around {@link PgStoreService}. Every public
 * method runs inside a `withTenant` transaction so `dsh.tenant` /
 * `dsh.uid` are pinned before any RLS-protected table is touched; the
 * GUC values themselves come from a {@link TenantContext} the caller
 * assembles (typically from the authenticated session — `@deepseek-ai/
 * dsh-host-auth` — or from the system identity for background work).
 *
 * The service does NOT register HTTP routes. Wire-up of
 * `GET /mu/v1/lookup` and `POST /mu/v1/ensure/{type}` is the
 * `@deepseek-ai/dsh-server` package's responsibility; this module only
 * exposes the business logic.
 *
 * @module @deepseek-ai/dsh-host-lookup
 */

import type { PgStoreService } from '@deepseek-ai/dsh-storage-postgres'
import type { PoolClient } from 'pg'
import { validateBizKey } from './biz-key.ts'
import { LookupError } from './error.ts'
import type {
  BizKey,
  EnsureRequest,
  LookupOutcome,
  LookupRecord,
  LookupType,
  TenantContext,
  TenantId,
  UserId,
  WorkspaceId,
  SessionId,
} from './types.ts'

/** Per-type table name and id column for the SQL we generate. */
interface TABLE {
  table: string
  idColumn: 'user_id' | 'workspace_id' | 'session_id'
}

const TABLE_BY_TYPE: Readonly<Record<LookupType, TABLE>> = Object.freeze({
  user: { table: 'app_user', idColumn: 'user_id' },
  workspace: { table: 'workspace', idColumn: 'workspace_id' },
  session: { table: 'session_meta', idColumn: 'session_id' },
})

/** The shape returned by the SELECT below. Coerced into {@link LookupRecord}. */
interface RawRow {
  id: string
  created_at: Date
  updated_at: Date
}

/** Configuration for {@link LookupService}. */
export interface LookupServiceOptions {
  /** The mounted {@link PgStoreService} — owns the pool + migrations. */
  readonly pgstore: PgStoreService
}

/**
 * Resolve a single row by `(tenant_id, biz_key)`. Returns either a `hit`
 * outcome carrying the row or a `miss` outcome the caller decides what
 * to do with (typically fall through to `ensure`).
 *
 * @param ctx - Tenant context assembled by the caller; pins `dsh.tenant`.
 * @param type - The lookup category; determines the table and the prefix.
 * @param bizKey - The host-side key (validated against the type).
 * @returns Discriminated outcome; safe to destructure on `kind`.
 */
export class LookupService {
  readonly options: LookupServiceOptions

  constructor(options: LookupServiceOptions) {
    this.options = options
  }

  /**
   * Run a one-row reverse lookup. The transaction is opened, the GUC is
   * pinned, the SELECT runs, the transaction commits — even if no row
   * is found. Returning a `miss` is normal and not an error condition.
   *
   * @param ctx - Tenant context for the surrounding transaction.
   * @param type - Lookup category.
   * @param bizKey - Host-side key (validated against `type`).
   * @returns Either a `hit` outcome with the row, or a `miss`.
   */
  async lookup<T extends LookupType>(
    ctx: TenantContext,
    type: T,
    bizKey: string,
  ): Promise<LookupOutcome<T>> {
    const validated = validateBizKey(bizKey, type)
    const table = TABLE_BY_TYPE[type]
    const result = await this.options.pgstore.client.withTenant(ctx, async (client) => {
      return client.query<RawRow>(
        `SELECT ${table.idColumn} AS id, created_at, updated_at
           FROM ${table.table}
          WHERE tenant_id = $1 AND biz_key = $2`,
        [ctx.tenantId, validated],
      )
    })
    const row = result.rows[0]
    if (!row) return { kind: 'miss' }
    return {
      kind: 'hit',
      record: this.shapeRecord<T>(ctx.tenantId, validated, { ...row, kind: type }),
    }
  }

  /**
   * Idempotent ensure. If a row already exists for `(tenant_id, biz_key)`
   * it is returned unchanged; otherwise a minimal row is inserted with
   * `tenant_id` + `biz_key` and then read back.
   *
   * `attrs` is currently unused at the row level (the multi-tenant schema
   * does not carry a free-form JSONB column); it is reserved so callers
   * may begin passing host-side attributes ahead of the migration that
   * will expose them. When that lands, this method will start writing
   * the attribute column during the INSERT.
   *
   * @param ctx - Tenant context for the surrounding transaction.
   * @param request - Type-narrowed ensure request.
   * @returns The row that now exists (newly created or pre-existing).
   */
  async ensure<T extends LookupType>(
    ctx: TenantContext,
    request: EnsureRequest<T>,
  ): Promise<LookupRecord<T>> {
    const validated = validateBizKey(request.bizKey, request.type)
    const table = TABLE_BY_TYPE[request.type]
    const result = await this.options.pgstore.client.withTenant(ctx, async (client) => {
      // Step 1: insert-or-noop. ON CONFLICT DO NOTHING keeps the row
      // untouched when it already exists — ensure is idempotent.
      await client.query(
        `INSERT INTO ${table.table} (tenant_id, biz_key)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, biz_key) DO NOTHING`,
        [request.tenantId, validated],
      )
      // Step 2: read back the row that now exists. This second SELECT is
      // intentional: a one-statement CTE is faster in isolation but harder
      // to keep correct as attrs columns land.
      return client.query<RawRow>(
        `SELECT ${table.idColumn} AS id, created_at, updated_at
           FROM ${table.table}
          WHERE tenant_id = $1 AND biz_key = $2`,
        [request.tenantId, validated],
      )
    })
    const row = result.rows[0]
    if (!row) {
      // Should be unreachable — INSERT ... ON CONFLICT DO NOTHING followed
      // by SELECT on the same predicate cannot legitimately return zero rows
      // unless something deleted the row between the two statements.
      throw new LookupError('not-found',
        `ensure for (${request.type}, "${validated}") returned no row after insert-or-noop`,
      )
    }
    return this.shapeRecord<T>(request.tenantId, validated, { ...row, kind: request.type })
  }

  /**
   * Coerce a raw row returned by the SQL above into a {@link LookupRecord}.
   * The id column carries the appropriate UUID type per `T`; the explicit
   * per-type branch keeps the branded narrowing visible at the call site.
   *
   * @param tenantId - Tenant that owns the row.
   * @param bizKey - The matched biz_key.
   * @param row - Raw row returned by the SELECT, carrying a `kind` field.
   * @returns The typed record.
   */
  private shapeRecord<T extends LookupType>(
    tenantId: TenantId,
    bizKey: BizKey,
    row: RawRow & { kind: T },
  ): LookupRecord<T> {
    switch (row.kind) {
      case 'user':
        return LookupService.shapeUserRecord(tenantId, bizKey, row) as LookupRecord<T>
      case 'workspace':
        return LookupService.shapeWorkspaceRecord(tenantId, bizKey, row) as LookupRecord<T>
      case 'session':
        return LookupService.shapeSessionRecord(tenantId, bizKey, row) as LookupRecord<T>
    }
  }

  /** Per-type variant for the user lookup. */
  private static shapeUserRecord(
    tenantId: TenantId,
    bizKey: BizKey,
    row: RawRow,
  ): LookupRecord<'user'> {
    return {
      tenantId,
      bizKey,
      id: row.id as UserId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** Per-type variant for the workspace lookup. */
  private static shapeWorkspaceRecord(
    tenantId: TenantId,
    bizKey: BizKey,
    row: RawRow,
  ): LookupRecord<'workspace'> {
    return {
      tenantId,
      bizKey,
      id: row.id as WorkspaceId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** Per-type variant for the session lookup. */
  private static shapeSessionRecord(
    tenantId: TenantId,
    bizKey: BizKey,
    row: RawRow,
  ): LookupRecord<'session'> {
    return {
      tenantId,
      bizKey,
      id: row.id as SessionId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

// Note: `UserId`, `WorkspaceId`, `SessionId` and `LookupRecord<T>['id']` are
// only referenced through the `LookupRecord` shape; the explicit imports keep
// the type narrowing visible at the module boundary.
export type { UserId, WorkspaceId, SessionId }
export type { PoolClient }