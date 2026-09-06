/**
 * `#14` — `dsh-migrate-multiuser`: the operator entry point that ships
 * the multi-tenant schema (the four `.sql` files under
 * `@deepseek-ai/dsh-storage-postgres/migrations/`) to a live PostgreSQL
 * cluster.
 *
 * The CLI is intentionally narrow. It does three things and three
 * things only:
 *
 *   1. read `PG_CONNECTION_STRING` (and an optional `DSH_PG_SCHEMA`),
 *   2. construct a {@link PgStoreService} with `autoMigrate: false`,
 *   3. call {@link applyMigrations} explicitly and report applied /
 *      skipped lists with stable exit codes.
 *
 * The `--plan` flag prints the migration files that *would* be applied
 * without touching the database. It is the dev-mode ergonomics layer so
 * a `pnpm dlx dsh-migrate-multiuser --plan` run needs no credentials.
 *
 * @module @deepseek-ai/dsh-host-cli-migrate
 */

import type { Migration } from '@deepseek-ai/dsh-storage-postgres'

/** `--plan` is dry-run; everything else actually migrates. */
export type CliMode = 'plan' | 'run'

/** Parse argv into a CLI invocation. The shape is intentionally simple — commander is overkill. */
export interface CliInvocation {
  readonly mode: CliMode
  readonly connectionString: string | undefined
  readonly schema: string
  readonly help: boolean
}

/** Conventional exit codes so wrappers can branch on outcome without string parsing. */
export const ExitCode = Object.freeze({
  ok: 0,
  plan: 0,
  alreadyUpToDate: 0,
  usage: 64,
  missingConnString: 65,
  schemaVersionDrift: 70,
  networkFailure: 75,
  internalError: 1,
} as const)

/** Parse argv (excluding node + script paths). */
export function parseArgs(argv: readonly string[]): CliInvocation {
  let mode: CliMode = 'run'
  let connectionString: string | undefined = process.env['PG_CONNECTION_STRING']
  let schema = process.env['DSH_PG_SCHEMA'] ?? 'dbo'
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--plan') mode = 'plan'
    else if (arg === '--run') mode = 'run'
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg.startsWith('--connection=')) {
      connectionString = arg.slice('--connection='.length)
    } else if (arg === '--connection' && i + 1 < argv.length) {
      connectionString = argv[++i]
    } else if (arg.startsWith('--schema=')) {
      schema = arg.slice('--schema='.length)
    } else if (arg === '--schema' && i + 1 < argv.length) {
      schema = argv[++i]!
    } else {
      throw new CliUsageError(`unknown flag: ${arg}`)
    }
  }
  return { mode, connectionString, schema, help }
}

/** Thrown when argv is malformed. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

/** Print the long-form help to stdout. */
export function printHelp(): string {
  return [
    'dsh-migrate-multiuser — apply the @deepseek-ai/dsh-storage-postgres',
    'migration set (tenant / app_user / workspace / workspace_member /',
    'session_meta / session_share / memory / artifact / plugin / policy /',
    'audit_log + RLS + biz_key + attrs) to a PostgreSQL cluster.',
    '',
    'Usage:',
    '  dsh-migrate-multiuser [--plan | --run] [options]',
    '',
    'Options:',
    '  --plan                    List the migrations without touching the database',
    '  --run                     Apply the migrations (default)',
    '  --connection=<url>        PostgreSQL URL (default: $PG_CONNECTION_STRING)',
    '  --schema=<name>           Postgres search_path (default: $DSH_PG_SCHEMA or "dbo")',
    '  -h, --help                Show this help text',
    '',
    'Exit codes:',
    '   0   applied + already-up-to-date',
    '   1   unexpected error (reported on stderr)',
    '  64   usage error (unknown flag)',
    '  65   missing PG_CONNECTION_STRING',
    '  70   schema_migrations drift (a recorded file changed)',
    '  75   network/connection failure',
  ].join('\n')
}

/**
 * List the migrations the bundle ships. In `--plan` mode this is the
 * whole answer the operator needs; in `--run` mode the same list is
 * displayed before {@link applyMigrations} walks it.
 *
 * Defers the dynamic import of `@deepseek-ai/dsh-storage-postgres` so
 * the rest of the module loads without the package on the resolution
 * path (smoke tests, `--help`, `--bogus`).
 *
 * @param dir - Migration directory; defaults to the package's bundled dir.
 * @returns The sorted migration list.
 */
export async function listMigrations(dir?: string): Promise<readonly Migration[]> {
  const { loadMigrations, DEFAULT_MIGRATIONS_DIR } = await import('@deepseek-ai/dsh-storage-postgres')
  return loadMigrations(dir ?? DEFAULT_MIGRATIONS_DIR)
}

/**
 * Apply the bundle and return the {@link applyMigrations} result.
 * Defers the dynamic import so module load stays independent of the
 * storage backend's resolution path.
 */
export async function runMigrations(opts: {
  readonly connectionString: string
  readonly schema: string
}): Promise<Awaited<ReturnType<typeof import('@deepseek-ai/dsh-storage-postgres').applyMigrations>>> {
  const { PgStoreService, applyMigrations } = await import('@deepseek-ai/dsh-storage-postgres')
  const service = new PgStoreService(
    // ctx is currently unused by PgStoreService; build a no-op proxy.
    { logger: console } as never,
    {
      pool: { connectionString: opts.connectionString },
      schema: opts.schema,
      autoMigrate: false,
    },
  )
  try {
    return await applyMigrations(service.client)
  } finally {
    await service.client.close()
  }
}

/** Render the migration result as a human-readable summary. */
export function render(
  result: Awaited<ReturnType<typeof import('@deepseek-ai/dsh-storage-postgres').applyMigrations>> | readonly Migration[],
): string {
  if (Array.isArray(result)) {
    const lines = [`Found ${result.length} migration file(s):`]
    for (const m of result) lines.push(`  - ${m.file}`)
    return lines.join('\n')
  }
  const r = result as { applied: readonly string[]; skipped: readonly string[]; recorded: ReadonlyMap<string, string> }
  const lines: string[] = []
  lines.push(`Applied: ${r.applied.length}`)
  for (const f of r.applied) lines.push(`  + ${f}`)
  lines.push(`Skipped (already at checksum): ${r.skipped.length}`)
  for (const f of r.skipped) lines.push(`  = ${f}`)
  lines.push(`Recorded total: ${r.recorded.size}`)
  return lines.join('\n')
}

/**
 * Compose {@link parseArgs} + {@link render}: the entry point a
 * shebang line invokes. Reuses its own logic but separates the I/O so
 * tests can substitute.
 *
 * @param argv - argv (excluding `node` and script path).
 * @param stdout - Where to write summaries (defaults to `process.stdout.write`).
 * @param stderr - Where to write errors.
 * @returns The exit code that the wrapping shell should propagate.
 */
export async function runCli(
  argv: readonly string[],
  stdout: (s: string) => void = s => process.stdout.write(s),
  stderr: (s: string) => void = s => process.stderr.write(s),
): Promise<number> {
  let parsed: CliInvocation
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    stderr(`${printHelp()}\n`)
    return ExitCode.usage
  }
  if (parsed.help) {
    stdout(`${printHelp()}\n`)
    return ExitCode.ok
  }
  try {
    const list = await listMigrations()
    if (parsed.mode === 'plan') {
      stdout(`${render(list)}\n`)
      return ExitCode.plan
    }
    if (parsed.connectionString === undefined) {
      stderr('error: PG_CONNECTION_STRING is not set and --connection was not given\n')
      return ExitCode.missingConnString
    }
    const result = await runMigrations({
      connectionString: parsed.connectionString,
      schema: parsed.schema,
    })
    stdout(`${render(result)}\n`)
    return result.applied.length === 0 ? ExitCode.alreadyUpToDate : ExitCode.ok
  } catch (err) {
    stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    if (err instanceof Error && err.name === 'DshPostgresError' && err.message.includes('migration-failed')) {
      return ExitCode.schemaVersionDrift
    }
    if (err instanceof Error && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(err.message)) {
      return ExitCode.networkFailure
    }
    return ExitCode.internalError
  }
}
