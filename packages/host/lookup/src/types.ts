/**
 * Domain types for the host-side business-key reverse-lookup family.
 *
 * The lookup plugin is a thin orchestrator: it takes a stable business key
 * the host uses (`aims.{userCode}` / `patient.{cureno}` / `visit.{visitId}`)
 * and resolves it to a UUID inside the tenant it belongs to. The biz_key
 * uniqueness is enforced by the storage-postgres schema (see migration
 * `0003_biz_key.sql`), so this module only describes the contract.
 *
 * @module @deepseek-ai/dsh-host-lookup
 */

/** Branded primitive: a UUID that has been validated as a tenant id. */
export type TenantId = string & { readonly [BRAND]: 'TenantId' }

/** Branded primitive: a UUID that has been validated as an app_user id. */
export type UserId = string & { readonly [BRAND]: 'UserId' }

/** Branded primitive: a UUID that has been validated as a workspace id. */
export type WorkspaceId = string & { readonly [BRAND]: 'WorkspaceId' }

/** Branded primitive: a UUID that has been validated as a session_meta id. */
export type SessionId = string & { readonly [BRAND]: 'SessionId' }

/**
 * The three host-side lookup categories. Each maps 1:1 to a table that owns
 * a `biz_key` column with a `UNIQUE (tenant_id, biz_key)` constraint.
 */
export type LookupType = 'user' | 'workspace' | 'session'

/**
 * The host-side biz_key three-prefix convention (decision point ⑥, plan v0.4).
 * The plugin does NOT interpret the prefix — it merely validates the shape
 * and rejects unknown prefixes before the SQL round-trip. The DSH side
 * enforces uniqueness; semantic meaning is the host's responsibility.
 */
export type BizKeyPrefix = 'aims' | 'patient' | 'visit'

/**
 * A biz_key string is `${prefix}.${host-id}` where `prefix` is one of the
 * three namespaces above and `host-id` is the host-side identifier (userCode,
 * cureno, or visitId). The host-id may itself contain dots or other safe
 * punctuation, so the regex is intentionally permissive after the first dot.
 */
export type BizKey = string & { readonly [BRAND]: 'BizKey' }

/** Mapping of {@link LookupType} to the UUID type it resolves to. */
export interface LookupRecordMap {
  user: UserId
  workspace: WorkspaceId
  session: SessionId
}

/** The result of a successful lookup or ensure call. */
export interface LookupRecord<T extends LookupType> {
  /** Tenant that owns this row; mirrors the lookup input. */
  readonly tenantId: TenantId
  /** The biz_key that was matched. */
  readonly bizKey: BizKey
  /** The UUID primary key of the row. */
  readonly id: LookupRecordMap[T]
  /**
   * Row creation timestamp. Always present — every table in scope stamps
   * `created_at NOT NULL DEFAULT now()`.
   */
  readonly createdAt: Date
  /**
   * Row last-update timestamp. Always present — every table in scope stamps
   * `updated_at NOT NULL DEFAULT now()` and a trigger refreshes it on UPDATE.
   */
  readonly updatedAt: Date
}

/**
 * Optional attributes to apply during an `ensure` call when the row does not
 * yet exist. Only fields the host wants to set at creation time should be
 * included — fields like `created_at` / `updated_at` / `tenant_id` / `biz_key`
 * are owned by the orchestrator.
 */
export interface EnsureAttributes {
  /** Free-form host-side attributes — never parsed by the lookup plugin. */
  readonly [field: string]: unknown
}

/**
 * Input shape for the ensure family. `attrs` is only consulted when the row
 * has to be inserted; existing rows are returned untouched regardless of what
 * the caller passes (idempotency is the point of ensure).
 */
export interface EnsureRequest<T extends LookupType> {
  readonly tenantId: TenantId
  readonly bizKey: BizKey
  /** Type-narrowed for clarity; a runtime check still enforces it. */
  readonly type: T
  readonly attrs?: EnsureAttributes
}

/** A reverse-lookup miss. The host decides whether to fall back to ensure. */
export type LookupMiss = undefined

/**
 * Outcome of a single {@link LookupService} call. Discriminated by `kind`
 * so callers cannot read `id` on a miss by accident.
 */
export type LookupOutcome<T extends LookupType> =
  | { readonly kind: 'hit'; readonly record: LookupRecord<T> }
  | { readonly kind: 'miss' }