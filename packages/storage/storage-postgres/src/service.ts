/**
 * The cordis-provided service: owns one {@link PgClient} and runs the
 * migrations once on activation. Mounted on the storage hub by no-one —
 * the package registers itself as `ctx.pgstore` so consumers can read and
 * write tenant-scoped data without going through the KV-shaped hub.
 * @module @deepseek-ai/dsh-storage-postgres/src/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { PgClient, type PgClientOptions } from './client.ts'
import { applyMigrations } from './migrate.ts'
import { DshPostgresError } from './error.ts'
import type { MigrationResult } from './types.ts'

/** Resolved service configuration (after schema default + autoMigrate default). */
export interface ResolvedPgStoreConfig extends PgClientOptions {
  /** Run bundled migrations during {@link PgStoreService.activate}. Default: true. */
  readonly autoMigrate: boolean
}

/**
 * The on-cordis `ctx.pgstore` value. Owns the pool lifecycle, runs the
 * migrations at activation, and closes the pool at disposal. Domain code
 * reads / writes through {@link PgClient.withTenant}; nothing else holds a
 * reference to the underlying `pg.Pool`.
 */
export class PgStoreService {
  /** Resolved configuration with defaults filled in. */
  readonly config: ResolvedPgStoreConfig

  /** The PostgreSQL client wrapper; safe to use after {@link activate} resolves. */
  readonly client: PgClient

  private _migrations: MigrationResult | undefined
  private _activatePromise: Promise<void> | undefined
  private _closed = false

  /**
   * @param ctx - Cordis context (unused today; reserved for tracing hook).
   * @param config - Validated plugin configuration.
   */
  constructor(_ctx: Context, config: PgClientOptions & { autoMigrate?: boolean }) {
    this.config = { ...config, autoMigrate: config.autoMigrate ?? true }
    this.client = new PgClient(config)
  }

  /**
   * Run migrations once and remember the result. Idempotent: a second call
   * resolves to the same value; concurrent calls share one promise.
   * @returns the migration summary from the first run.
   */
  async activate(): Promise<MigrationResult> {
    if (this._closed) throw new DshPostgresError('pool-closed', 'pgstore service is closed')
    if (this._migrations !== undefined) return this._migrations
    this._activatePromise ??= (async () => {
      const result = this.config.autoMigrate
        ? await applyMigrations(this.client)
        : { applied: [], skipped: [], recorded: new Map<string, string>() }
      this._migrations = result
    })()
    await this._activatePromise
    return this._migrations!
  }

  /** Drain the pool and refuse further calls. */
  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    if (this._activatePromise !== undefined) {
      // Let any in-flight activate settle before tearing the pool out.
      try { await this._activatePromise } catch { /* reported at the original caller */ }
    }
    await this.client.close()
  }
}