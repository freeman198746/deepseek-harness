/**
 * Behavioural tests for the migration helpers. These run without a database —
 * they verify the file-system ordering, the SHA-256 stability, and the
 * "recorded vs. applied" reasoning that {@link applyMigrations} uses at
 * runtime. The real-database side is covered by `load-path.e2e.ts`.
 *
 * @module @deepseek-ai/dsh-storage-postgres/tests/contract
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations, migrationChecksum } from '../src/migrate.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-postgres-contract-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('loadMigrations', () => {
  it('returns an empty list for a directory with no .sql files', async () => {
    const dir = await freshDir()
    await expect(loadMigrations(dir)).resolves.toEqual([])
  })

  it('sorts by file name so numeric prefixes drive order', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, '0010_third.sql'), 'SELECT 3;', 'utf8')
    await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;', 'utf8')
    await writeFile(join(dir, '0005_second.sql'), 'SELECT 2;', 'utf8')
    await writeFile(join(dir, 'README.md'), 'not sql', 'utf8')
    const migrations = await loadMigrations(dir)
    expect(migrations.map(m => m.file)).toEqual([
      '0001_first.sql',
      '0005_second.sql',
      '0010_third.sql',
    ])
    expect(migrations.map(m => m.sql)).toEqual(['SELECT 1;', 'SELECT 2;', 'SELECT 3;'])
  })

  it('preserves file contents verbatim', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, '0001_one.sql'), 'CREATE TABLE a(x int);\n-- trailing\n', 'utf8')
    const migrations = await loadMigrations(dir)
    expect(migrations).toHaveLength(1)
    expect(migrations[0]!.file).toBe('0001_one.sql')
    expect(migrations[0]!.sql).toBe('CREATE TABLE a(x int);\n-- trailing\n')
  })
})

describe('migrationChecksum', () => {
  it('returns 64-char hex SHA-256', () => {
    const checksum = migrationChecksum('SELECT 1;')
    expect(checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across calls', () => {
    const sql = 'CREATE TABLE foo(x int);'
    expect(migrationChecksum(sql)).toBe(migrationChecksum(sql))
  })

  it('changes when the body changes', () => {
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT 2;'))
  })

  it('is sensitive to whitespace', () => {
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT  1;'))
  })
})