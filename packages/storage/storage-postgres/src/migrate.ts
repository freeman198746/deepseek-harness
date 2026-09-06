/**
 * Migration runner: ships the SQL files in `migrations/` to the database in
 * file-name order. Idempotent — every applied file lands a checksum in
 * `schema_migrations`; later runs skip a file whose recorded checksum still
 * matches, and refuse to apply a changed file to a row that already exists
 * (the author must bump the numeric prefix and add a new file).
 * @module @deepseek-ai/dsh-storage-postgres/src/migrate
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DshPostgresError } from './error.ts'
import type { PgClient } from './client.ts'
import type { Migration, MigrationResult } from './types.ts'

/** Default directory holding the SQL files shipped with the package. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Load every `.sql` file under `dir` into {@link Migration} records, sorted
 * by file name. Authors must keep the numeric prefix monotonic; the runner
 * does not interpret the prefix, it just trusts the lexicographic order.
 * @param dir - Directory to scan.
 * @returns one migration per file, oldest first.
 */
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir)
  const sqlFiles = entries.filter(name => name.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  for (const file of sqlFiles) {
    const sql = await readFile(join(dir, file), 'utf8')
    migrations.push({ file, sql })
  }
  return migrations
}

/**
 * Compute a stable hash for a migration body. SHA-256 hex; recorded next to
 * the file name in `schema_migrations` so a hand-edited file (or a rebase
 * that re-orders it) refuses to silently re-apply.
 * @param sql - Migration body.
 * @returns 64-char hex digest.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Ensure `schema_migrations` exists. Safe to call repeatedly: a guarded
 * `CREATE TABLE IF NOT EXISTS` is the only side effect.
 * @param client - Open pg client.
 */
async function ensureMigrationsTable(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      file TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Apply every migration whose file name is not already in
 * `schema_migrations`. Each migration runs in its own transaction so a
 * partial failure leaves the database at the previously-good state.
 * @param pg - PgClient to apply migrations through.
 * @param migrations - Files to consider; defaults to the bundled directory.
 * @returns which files were applied vs skipped and the recorded checksums.
 */
export async function applyMigrations(
  pg: PgClient,
  migrations?: readonly Migration[],
): Promise<MigrationResult> {
  const list = migrations ?? await loadMigrations()
  await pg.withConnection(async (client) => {
    await ensureMigrationsTable(client)
  })
  const recorded = new Map<string, string>()
  const existing = await pg.query<{ file: string; checksum: string }>(
    'SELECT file, checksum FROM schema_migrations',
  )
  for (const row of existing.rows) {
    recorded.set(row.file, row.checksum)
  }

  const applied: string[] = []
  const skipped: string[] = []
  for (const migration of list) {
    const checksum = migrationChecksum(migration.sql)
    const prior = recorded.get(migration.file)
    if (prior === checksum) {
      skipped.push(migration.file)
      continue
    }
    if (prior !== undefined) {
      throw new DshPostgresError(
        'migration-failed',
        `migration '${migration.file}' is already recorded with checksum ${prior}; `
        + 'a file edit needs a new numeric prefix, not an in-place rewrite',
      )
    }
    await pg.withConnection(async (client) => {
      try {
        await client.query(migration.sql)
      } catch (error) {
        throw new DshPostgresError(
          'migration-failed',
          `migration '${migration.file}' failed to apply`,
          { cause: error },
        )
      }
      await client.query(
        'INSERT INTO schema_migrations (file, checksum) VALUES ($1, $2)',
        [migration.file, checksum],
      )
    })
    recorded.set(migration.file, checksum)
    applied.push(migration.file)
  }
  return { applied, skipped, recorded }
}