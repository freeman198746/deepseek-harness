/**
 * PostgreSQL connection wrapper: owns one `pg.Pool`, exposes a `withTenant`
 * helper that pins `dsh.tenant`, `dsh.uid`, and `dsh.trace_id` for the
 * duration of the callback, and proxies ad-hoc queries.
 *
 * Every wrapper opens a transaction so `SET LOCAL` survives until COMMIT;
 * the connection is released back to the pool whether the body succeeds,
 * rejects, or aborts.
 * @module @deepseek-ai/dsh-storage-postgres/src/client
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { DshPostgresError } from './error.ts'
import type { TenantContext } from './types.ts'

/** Resolved connection options for the underlying `pg.Pool`. */
export interface PgClientOptions {
  /** `pg.Pool` configuration. `connectionString` is the canonical input. */
  readonly pool: import('pg').PoolConfig
  /** Optional Postgres `search_path`; the default is `dbo`. */
  readonly schema?: string
}

/** Result row type when callers don't need a stronger shape. */
export type Row = QueryResultRow

/**
 * Single-owner PostgreSQL client wrapper. Constructed once per service
 * instance; `withTenant` hands a checked-out connection to the callback, then
 * releases it. Direct {@link query} calls bypass tenant scoping and exist
 * for migrations and admin operations.
 */
export class PgClient {
  private readonly pool: Pool
  private readonly schema: string
  private closed = false

  constructor(options: PgClientOptions) {
    this.pool = new Pool(options.pool)
    this.schema = options.schema ?? 'dbo'
  }

  /**
   * Acquire a connection, run `BEGIN`, set the tenant GUC, run the callback,
   * then commit. A failing body or COMMIT triggers ROLLBACK before the
   * connection is released; ROLLBACK's own failure is swallowed so the
   * original rejection stays the actionable cause.
   * @param context - Tenant / user / trace ids for this transaction.
   * @param fn - Operation to run on the checked-out client.
   * @returns the value `fn` resolves to.
   */
  async withTenant<T>(
    context: TenantContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    const client = await this.pool.connect()
    let began = false
    try {
      await client.query('BEGIN')
      began = true
      // `set_config(name, value, is_local=true)` is the parameter-safe form
      // of `SET LOCAL`. The boolean third argument keeps the value scoped to
      // the current transaction; anything outside this BEGIN is unaffected.
      await client.query(
        `SELECT set_config('dsh.tenant', $1, true), set_config('dsh.uid', $2, true)`,
        [context.tenantId, context.userId],
      )
      if (context.traceId !== undefined) {
        await client.query(
          `SELECT set_config('dsh.trace_id', $1, true)`,
          [context.traceId],
        )
      }
      // Fail-fast the search_path so unqualified table names resolve into the
      // configured schema before the body runs — RLS policies still apply on
      // top, but mis-named tables surface as a clean error here.
      await client.query(`SET LOCAL search_path TO "${this.schema}"`)
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The original rejection remains the actionable cause.
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Acquire a connection without tenant scoping. Reserved for migrations
   * (`withTenant` would inject `dsh.tenant` before schema_migrations exists
   * and trigger fail-closed). Every other caller should use {@link withTenant}.
   * @param fn - Operation to run on the checked-out client.
   * @returns the value `fn` resolves to.
   */
  async withConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertOpen()
    const client = await this.pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  /**
   * Convenience for migrations and ad-hoc reads. Goes through `pool.query`,
   * which acquires and releases a connection internally — do not use this from
   * inside a tenant scope (the GUC vanishes at the implicit COMMIT).
   * @param text - SQL text.
   * @param params - Bound parameters.
   * @returns the pg query result.
   */
  async query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    this.assertOpen()
    return this.pool.query<R>(text, params as unknown[] | undefined)
  }

  /** Drain every idle connection and refuse further acquisitions. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }

  private assertOpen(): void {
    if (this.closed) throw new DshPostgresError('pool-closed', 'pg client is closed')
  }
}