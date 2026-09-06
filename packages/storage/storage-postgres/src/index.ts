/**
 * PostgreSQL row store for the multi-tenant DeepSeek Harness storage
 * backend. Registers as `ctx.pgstore`; consumers call
 * `ctx.pgstore.client.withTenant(...)` to pin `dsh.tenant` / `dsh.uid` /
 * `dsh.trace_id` for one transaction. The package does NOT mount on the
 * storage hub — the hub is KV-only and the row store needs JOIN, foreign
 * keys, and Row-Level Security.
 *
 * @module @deepseek-ai/dsh-storage-postgres
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PgStoreService } from './service.ts'

/** Cordis plugin name. */
export const name = 'storage-postgres'

/** No prerequisites — the package owns its own pool. */
export const inject: readonly string[] = []

/**
 * Plugin configuration. `connectionString` is the only required field;
 * everything else has a sensible default. `autoMigrate` defaults to `true`
 * for ergonomic activation; operators managing migrations through an
 * external tool (e.g. `psql -f`) should set it to `false`.
 */
export interface Config {
  /** `pg.PoolConfig.connectionString`. Required. */
  connectionString: string
  /**
   * Postgres `search_path` the wrapper pins via `SET LOCAL` inside every
   * tenant transaction. Defaults to `dbo`.
   */
  schema?: string
  /** Maximum pool size. Defaults to `pg`'s own default (10). */
  maxPoolSize?: number
  /** Idle-connection timeout in ms. Defaults to `pg`'s default. */
  idleTimeoutMs?: number
  /** Connection timeout in ms. Defaults to `pg`'s default (no timeout). */
  connectionTimeoutMs?: number
  /**
   * Run the bundled migrations during `activate()`. Set to `false` when an
   * external migration pipeline owns the schema. Defaults to `true`.
   */
  autoMigrate?: boolean
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  connectionString: z.string().required(),
  schema: z.string().default('dbo'),
  maxPoolSize: z.number().min(1).optional(),
  idleTimeoutMs: z.number().min(0).optional(),
  connectionTimeoutMs: z.number().min(0).optional(),
  autoMigrate: z.boolean().default(true),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The PostgreSQL row-store service. Mounted by `@deepseek-ai/dsh-storage-postgres`. */
    pgstore: PgStoreService
  }
}

/**
 * Mount the PostgreSQL row store on the cordis context.
 *
 * Registers `ctx.pgstore` synchronously so consumers can read the service
 * immediately, then schedules `activate()` (which runs the migrations when
 * `autoMigrate` is on) as an effect — the rest of the cordis assembly keeps
 * booting while the migrations land. The pool closes when the plugin
 * disposes.
 * @param ctx - Cordis context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new PgStoreService(ctx, {
    pool: {
      connectionString: config.connectionString,
      ...(config.maxPoolSize !== undefined ? { max: config.maxPoolSize } : {}),
      ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMillis: config.idleTimeoutMs } : {}),
      ...(config.connectionTimeoutMs !== undefined ? { connectionTimeoutMillis: config.connectionTimeoutMs } : {}),
    },
    ...(config.schema !== undefined ? { schema: config.schema } : {}),
    autoMigrate: config.autoMigrate,
  })
  ctx.provide('pgstore', service)
  ctx.effect(async () => {
    try {
      await service.activate()
    } catch (error) {
      ctx.logger.error('storage-postgres: activate() failed; service is mounted but migrations may be incomplete')
      throw error
    }
  }, 'storage-postgres.activate')
  ctx.effect(() => async () => {
    await service.close()
  }, 'storage-postgres.close')
}

export { PgStoreService } from './service.ts'
export { PgClient, type PgClientOptions } from './client.ts'
export { DshPostgresError, type DshPostgresErrorCode } from './error.ts'
export type {
  Migration,
  MigrationResult,
  StorageErrorCode,
  TenantContext,
  TenantId,
  UserId,
  WorkspaceId,
  SessionId,
  Branded,
} from './types.ts'
export { applyMigrations, loadMigrations, migrationChecksum, DEFAULT_MIGRATIONS_DIR } from './migrate.ts'