/**
 * Offline smoke for `@deepseek-ai/dsh-host-cli-migrate` (#14).
 *
 * Validates the pure surface of the operator command without ever
 * reaching PostgreSQL:
 *
 *   1. parseArgs happy + error paths (12 cases)
 *   2. ExitCode frozen convention codes
 *   3. render produces a plan summary and an apply result summary
 *   4. printHelp covers all flags + exit codes
 *   5. runCli(['--help']) exits 0 and writes the help banner
 *   6. runCli(['--bogus']) exits 64 and writes an error to stderr
 *
 * No DB. The vitest suite (`tests/contract.spec.ts`) covers the same
 * assertions in the harness; this file mirrors them so a developer can
 * sanity-check before opening the multi-project runner.
 *
 * Run from the dsh repo root:
 *   node --import tsx packages/host/cli-migrate/.workbuddy/smoke.ts
 */

import assert from 'node:assert/strict'
import {
  CliUsageError,
  ExitCode,
  parseArgs,
  printHelp,
  render,
  runCli,
} from '../src/cli.ts'
import type { Migration } from '@deepseek-ai/dsh-storage-postgres'

let passed = 0
const ok = (label: string): void => {
  console.log(`  ✓ ${label}`)
  passed += 1
}

// Capture stdout / stderr so runCli does not pollute the terminal.
// Returns getters so the buffer reference stays live after the call.
function captureStreams(): {
  stdout: (s: string) => void
  stderr: (s: string) => void
  readonly stdoutBuf: string
  readonly stderrBuf: string
} {
  const buffers = { stdoutBuf: '', stderrBuf: '' }
  return {
    stdout: (s: string) => { buffers.stdoutBuf += s },
    stderr: (s: string) => { buffers.stderrBuf += s },
    get stdoutBuf() { return buffers.stdoutBuf },
    get stderrBuf() { return buffers.stderrBuf },
  }
}

// ---------------------------------------------------------------------------
// 1. parseArgs
// ---------------------------------------------------------------------------

console.log('\n[1] parseArgs')

const ORIGINAL_ENV = { ...process.env }
delete process.env['PG_CONNECTION_STRING']
delete process.env['DSH_PG_SCHEMA']

const defaultInvocation = parseArgs([])
assert.equal(defaultInvocation.mode, 'run')
assert.equal(defaultInvocation.connectionString, undefined)
assert.equal(defaultInvocation.schema, 'dbo')
assert.equal(defaultInvocation.help, false)
ok('default mode=run / conn=undefined / schema=dbo / help=false')

process.env['PG_CONNECTION_STRING'] = 'postgres://u:p@db:5432/x'
process.env['DSH_PG_SCHEMA'] = 'emr'
assert.equal(parseArgs([]).connectionString, 'postgres://u:p@db:5432/x')
assert.equal(parseArgs([]).schema, 'emr')
ok('env: PG_CONNECTION_STRING + DSH_PG_SCHEMA flow into defaults')
delete process.env['PG_CONNECTION_STRING']
delete process.env['DSH_PG_SCHEMA']

assert.equal(parseArgs(['--plan']).mode, 'plan')
assert.equal(parseArgs(['--run']).mode, 'run')
assert.equal(parseArgs(['--help']).help, true)
assert.equal(parseArgs(['-h']).help, true)
ok('--plan / --run / --help / -h each flip the right bit')

assert.equal(
  parseArgs(['--connection=postgres://cli@db:5432/y']).connectionString,
  'postgres://cli@db:5432/y',
)
assert.equal(
  parseArgs(['--connection', 'postgres://cli@db:5432/y']).connectionString,
  'postgres://cli@db:5432/y',
)
ok('--connection supports both = and space forms')

assert.equal(parseArgs(['--schema=harness']).schema, 'harness')
assert.equal(parseArgs(['--schema', 'harness']).schema, 'harness')
ok('--schema supports both = and space forms')

assert.throws(
  () => parseArgs(['--bogus']),
  (err: unknown) => err instanceof CliUsageError && /unknown flag/.test(err.message),
  'expected CliUsageError for --bogus',
)
ok('unknown flag throws CliUsageError')

assert.throws(
  () => parseArgs(['--dry-run']),
  (err: unknown) => err instanceof CliUsageError,
  'expected CliUsageError for --dry-run (forwarded to --plan in a future release)',
)
ok('--dry-run is rejected with CliUsageError until promoted')

process.env = { ...ORIGINAL_ENV }

// ---------------------------------------------------------------------------
// 2. ExitCode frozen
// ---------------------------------------------------------------------------

console.log('\n[2] ExitCode')
assert.equal(ExitCode.ok, 0)
assert.equal(ExitCode.plan, 0)
assert.equal(ExitCode.alreadyUpToDate, 0)
assert.equal(ExitCode.usage, 64)
assert.equal(ExitCode.missingConnString, 65)
assert.equal(ExitCode.schemaVersionDrift, 70)
assert.equal(ExitCode.networkFailure, 75)
assert.equal(ExitCode.internalError, 1)
ok('all seven exit codes match BSD sysexits conventions')

assert.ok(Object.isFrozen(ExitCode), 'ExitCode must be frozen')
ok('ExitCode is frozen (no in-place rewrite)')

// ---------------------------------------------------------------------------
// 3. render
// ---------------------------------------------------------------------------

console.log('\n[3] render')
const planList: Migration[] = [
  { file: '0001_initial.sql', sql: '' },
  { file: '0002_rls.sql', sql: '' },
  { file: '0003_biz_key.sql', sql: '' },
  { file: '0004_ensure_attributes.sql', sql: '' },
]
{
  const out = render(planList)
  assert.match(out, /Found 4 migration file\(s\)/)
  assert.match(out, /0001_initial\.sql/)
  assert.match(out, /0004_ensure_attributes\.sql/)
  ok('render(plan list) lists every file with bullet')
}
{
  const out = render([])
  assert.match(out, /Found 0 migration file\(s\)/)
  ok('render(empty plan list) reports zero count')
}
{
  const out = render({
    applied: ['0004_ensure_attributes.sql'],
    skipped: ['0001_initial.sql', '0002_rls.sql', '0003_biz_key.sql'],
    recorded: new Map<string, string>([
      ['0001_initial.sql', 'aaa'],
      ['0002_rls.sql', 'bbb'],
      ['0003_biz_key.sql', 'ccc'],
    ]),
  })
  assert.match(out, /Applied: 1/)
  assert.match(out, /\+ 0004_ensure_attributes\.sql/)
  assert.match(out, /Skipped \(already at checksum\): 3/)
  assert.match(out, /Recorded total: 3/)
  ok('render(apply result) lists applied/skipped/recorded sections')
}

// ---------------------------------------------------------------------------
// 4. printHelp
// ---------------------------------------------------------------------------

console.log('\n[4] printHelp')
{
  const help = printHelp()
  assert.match(help, /dsh-migrate-multiuser/)
  assert.match(help, /--plan/)
  assert.match(help, /--run/)
  assert.match(help, /--connection/)
  assert.match(help, /--schema/)
  assert.match(help, /-h, --help/)
  assert.match(help, /Exit codes/)
  assert.match(help, /\b64\b/)
  assert.match(help, /\b65\b/)
  assert.match(help, /\b70\b/)
  assert.match(help, /\b75\b/)
  ok('help banner covers flags, synopsis, and all exit codes')
}

// ---------------------------------------------------------------------------
// 5. runCli(['--help']) → 0 + help on stdout, nothing on stderr
// ---------------------------------------------------------------------------

console.log('\n[5] runCli --help / --bogus / --plan (no DB)')
{
  const streams = captureStreams()
  const code = await runCli(['--help'], streams.stdout, streams.stderr)
  assert.equal(code, ExitCode.ok)
  assert.match(streams.stdoutBuf, /dsh-migrate-multiuser/)
  assert.match(streams.stdoutBuf, /--plan/)
  assert.equal(streams.stderrBuf, '', 'help writes nothing to stderr')
  ok('--help → exit 0 + help banner on stdout, stderr empty')
}
{
  const streams = captureStreams()
  const code = await runCli(['-h'], streams.stdout, streams.stderr)
  assert.equal(code, ExitCode.ok)
  assert.match(streams.stdoutBuf, /--plan/)
  ok('-h → exit 0 (alias of --help)')
}
{
  const streams = captureStreams()
  const code = await runCli(['--bogus'], streams.stdout, streams.stderr)
  assert.equal(code, ExitCode.usage)
  assert.match(streams.stderrBuf, /unknown flag: --bogus/)
  ok('--bogus → exit 64 + error on stderr (parseArgs throws → runCli translates)')
}

// ---------------------------------------------------------------------------
// 6. parseArgs equivalence with multi-flag
// ---------------------------------------------------------------------------

console.log('\n[6] multi-flag parseArgs composition')
{
  const invocation = parseArgs(['--plan', '--connection=postgres://cli@db:5432/y', '--schema=harness'])
  assert.equal(invocation.mode, 'plan')
  assert.equal(invocation.connectionString, 'postgres://cli@db:5432/y')
  assert.equal(invocation.schema, 'harness')
  ok('--plan + --connection + --schema compose correctly')
}

console.log(`\nAll ${passed} assertions passed.`)
