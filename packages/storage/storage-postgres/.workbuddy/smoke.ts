// Smoke check for the migration helpers — runs without vitest so we can
// validate the package before the full vitest harness recognises it. Verifies
// the same behaviours the vitest contract suite asserts:
//
//   * loadMigrations sorts by file name and preserves contents verbatim.
//   * migrationChecksum is a stable 64-char SHA-256 hex string.
//   * applyMigrations is idempotent (covered in load-path.e2e when PG is up).
//
// Run from the dsh repo root:
//   node --import tsx packages/storage/storage-postgres/.workbuddy/smoke.ts

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadMigrations, migrationChecksum } from '../src/migrate.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '..')

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'dsh-storage-postgres-smoke-'))
}

async function expectEmptyDir(): Promise<void> {
  const dir = await freshDir()
  try {
    const migrations = await loadMigrations(dir)
    assert.deepEqual(migrations, [], 'empty directory must yield no migrations')
    console.log('OK empty dir')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function expectSortByName(): Promise<void> {
  const dir = await freshDir()
  try {
    await writeFile(path.join(dir, '0010_third.sql'), 'SELECT 3;', 'utf8')
    await writeFile(path.join(dir, '0001_first.sql'), 'SELECT 1;', 'utf8')
    await writeFile(path.join(dir, '0005_second.sql'), 'SELECT 2;', 'utf8')
    await writeFile(path.join(dir, 'README.md'), 'not sql', 'utf8')
    const migrations = await loadMigrations(dir)
    assert.deepEqual(migrations.map(m => m.file), [
      '0001_first.sql',
      '0005_second.sql',
      '0010_third.sql',
    ], 'must sort by file name lexicographically')
    assert.deepEqual(migrations.map(m => m.sql), ['SELECT 1;', 'SELECT 2;', 'SELECT 3;'], 'must preserve sql verbatim')
    console.log('OK sort by name')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function expectChecksumShape(): void {
  const cs = migrationChecksum('SELECT 1;')
  assert.match(cs, /^[0-9a-f]{64}$/, 'checksum must be 64-char hex')
  assert.equal(cs, migrationChecksum('SELECT 1;'), 'checksum must be stable')
  assert.notEqual(cs, migrationChecksum('SELECT 2;'), 'checksum must change with body')
  console.log('OK checksum shape & stability')
}

async function expectShippedMigrationsLoad(): Promise<void> {
  // The real test: the package's bundled directory must load and stay in
  // lexicographic order (which matches the documented numeric prefix scheme).
  const migrations = await loadMigrations(path.join(pkgRoot, 'migrations'))
  assert.ok(migrations.length >= 4, `expected at least 4 bundled migrations, got ${migrations.length}`)
  const sorted = [...migrations].sort((a, b) => a.file.localeCompare(b.file))
  assert.deepEqual(migrations.map(m => m.file), sorted.map(m => m.file), 'bundled migrations must be sorted')
  // 0001_initial.sql must reference the canonical tables (one tenant root,
  // four core multi-tenant tables, plus the plugin/artifact/audit trio).
  const initial = migrations.find(m => m.file === '0001_initial.sql')
  assert.ok(initial, '0001_initial.sql must be present')
  const expectedTables = [
    'tenant',
    'app_user',
    'workspace',
    'workspace_member',
    'session_meta',
    'session_share',
    'memory',
    'artifact',
    'plugin',
    'plugin_policy',
    'audit_log',
  ]
  for (const table of expectedTables) {
    assert.ok(initial.sql.includes(`CREATE TABLE ${table}`) || initial.sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      `0001_initial.sql must declare ${table}`)
  }
  console.log(`OK shipped migrations (${migrations.length} files)`)
}

await expectEmptyDir()
await expectSortByName()
expectChecksumShape()
await expectShippedMigrationsLoad()

console.log('ALL CHECKS PASSED')