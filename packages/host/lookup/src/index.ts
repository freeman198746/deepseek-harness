/**
 * `@deepseek-ai/dsh-host-lookup` — host-side reverse-lookup and ensure
 * orchestrator for the multi-tenant row store.
 *
 * Mounts as `ctx.lookup`; the {@link LookupService} exposes a typed family
 * of `lookup` and `ensure` calls keyed by `(tenant_id, biz_key)`. The
 * package does NOT register HTTP routes — wiring
 * `GET /mu/v1/lookup` and `POST /mu/v1/ensure/{type}` is the
 * responsibility of `@deepseek-ai/dsh-server`.
 *
 * The plugin depends on the storage-postgres service already being
 * mounted (`ctx.pgstore`); the `inject` declaration enforces the ordering.
 *
 * @module @deepseek-ai/dsh-host-lookup
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LookupService } from './service.ts'

/** Cordis plugin name. */
export const name = 'host-lookup'

/** Mount after storage-postgres so `ctx.pgstore` is populated when we read it. */
export const inject: readonly string[] = ['pgstore']

/**
 * Plugin configuration. The lookup family has no runtime knobs of its own
 * yet — every method delegates to the storage-postgres pool — but the
 * shape is reserved so future settings (e.g. cross-tenant lookup mode for
 * system jobs) can land without breaking the public surface.
 */
export interface Config {
  /**
   * When `true`, `ensure` is allowed to insert rows for unknown biz_keys.
   * When `false` (the strict default), `ensure` still creates the row if
   * missing but treats an `attrs` argument as advisory — callers that
   * need to mutate host-owned columns must issue a follow-up UPDATE.
   */
  readonly allowEnsureInsert?: boolean
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  allowEnsureInsert: z.boolean().default(true),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host-side reverse-lookup orchestrator. Mounted by `@deepseek-ai/dsh-host-lookup`. */
    lookup: LookupService
  }
}

/**
 * Mount the lookup orchestrator on the cordis context.
 *
 * The service is constructed eagerly so consumers can read it as soon as
 * the registry completes; no asynchronous setup is required because
 * `LookupService` only holds a reference to the already-mounted
 * `ctx.pgstore`.
 *
 * @param ctx - Cordis context.
 * @param _config - Validated plugin configuration (reserved for future use).
 */
export function apply(ctx: Context, _config: Config): void {
  const service = new LookupService({ pgstore: ctx.pgstore })
  ctx.provide('lookup', service)
}

export { LookupService, type LookupServiceOptions } from './service.ts'
export { LookupError, type LookupErrorCode } from './error.ts'
export {
  BIZ_KEY_PREFIX_BY_TYPE,
  BIZ_KEY_PREFIXES,
  extractBizKeyPrefix,
  validateBizKey,
} from './biz-key.ts'
export type {
  BizKey,
  BizKeyPrefix,
  EnsureAttributes,
  EnsureRequest,
  LookupOutcome,
  LookupRecord,
  LookupRecordMap,
  LookupType,
  SessionId,
  TenantContext,
  TenantId,
  UserId,
  WorkspaceId,
} from './types.ts'