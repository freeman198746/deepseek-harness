/**
 * Contract tests for `@deepseek-ai/dsh-host-cli-migrate` (#14).
 *
 * Validates the pure parts of the operator command — argv parsing, exit
 * codes, error class, renderer, and the long-form help — without ever
 * talking to PostgreSQL. Live-DB runs are out of scope here; they are
 * covered by the manual `dsh-migrate-multiuser --run` invocation an
 * operator performs against a real cluster.
 *
 * @module @deepseek-ai/dsh-host-cli-migrate/contract
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'vitest'
import {
  CliUsageError,
  ExitCode,
  parseArgs,
  printHelp,
  render,
} from '../src/cli.ts'
import type { Migration } from '@deepseek-ai/dsh-storage-postgres'

// ---------------------------------------------------------------------------
// parseArgs — pure, but reads process.env for default connection / schema.
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  const ORIGINAL_ENV = { ...process.env }
  beforeEach(() => {
    delete process.env['PG_CONNECTION_STRING']
    delete process.env['DSH_PG_SCHEMA']
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  test('defaults to run mode when no flag is given', () => {
    const invocation = parseArgs([])
    assert.equal(invocation.mode, 'run')
    assert.equal(invocation.connectionString, undefined)
    assert.equal(invocation.schema, 'dbo')
    assert.equal(invocation.help, false)
  })

  test('reads PG_CONNECTION_STRING and DSH_PG_SCHEMA from env', () => {
    process.env['PG_CONNECTION_STRING'] = 'postgres://u:p@db:5432/x'
    process.env['DSH_PG_SCHEMA'] = 'emr'
    const invocation = parseArgs([])
    assert.equal(invocation.connectionString, 'postgres://u:p@db:5432/x')
    assert.equal(invocation.schema, 'emr')
  })

  test('--plan flips the mode to plan', () => {
    const invocation = parseArgs(['--plan'])
    assert.equal(invocation.mode, 'plan')
  })

  test('--run keeps the mode at run', () => {
    const invocation = parseArgs(['--run'])
    assert.equal(invocation.mode, 'run')
  })

  test('--help sets the help flag', () => {
    const invocation = parseArgs(['--help'])
    assert.equal(invocation.help, true)
  })

  test('-h sets the help flag', () => {
    const invocation = parseArgs(['-h'])
    assert.equal(invocation.help, true)
  })

  test('--connection=<url> overrides the env default', () => {
    const invocation = parseArgs(['--connection=postgres://cli@db:5432/y'])
    assert.equal(invocation.connectionString, 'postgres://cli@db:5432/y')
  })

  test('--connection <url> (space form) consumes the next argv entry', () => {
    const invocation = parseArgs(['--connection', 'postgres://cli@db:5432/y'])
    assert.equal(invocation.connectionString, 'postgres://cli@db:5432/y')
  })

  test('--schema=<name> overrides the env default', () => {
    const invocation = parseArgs(['--schema=harness'])
    assert.equal(invocation.schema, 'harness')
  })

  test('--schema <name> (space form) consumes the next argv entry', () => {
    const invocation = parseArgs(['--schema', 'harness'])
    assert.equal(invocation.schema, 'harness')
  })

  test('an unknown flag throws CliUsageError', () => {
    assert.throws(() => parseArgs(['--bogus']), (err: unknown) => {
      return err instanceof CliUsageError && err.message.includes('unknown flag')
    })
  })

  test('CliUsageError carries the name CliUsageError', () => {
    const err = new CliUsageError('boom')
    assert.equal(err.name, 'CliUsageError')
    assert.equal(err.message, 'boom')
  })

  test('multi-flag invocations compose correctly', () => {
    const invocation = parseArgs([
      '--plan',
      '--connection=postgres://cli@db:5432/y',
      '--schema=harness',
    ])
    assert.equal(invocation.mode, 'plan')
    assert.equal(invocation.connectionString, 'postgres://cli@db:5432/y')
    assert.equal(invocation.schema, 'harness')
  })
})

// ---------------------------------------------------------------------------
// ExitCode — frozen conventional codes so wrappers can branch on outcome.
// ---------------------------------------------------------------------------

describe('ExitCode', () => {
  test('ok / plan / alreadyUpToDate all collapse to 0', () => {
    assert.equal(ExitCode.ok, 0)
    assert.equal(ExitCode.plan, 0)
    assert.equal(ExitCode.alreadyUpToDate, 0)
  })

  test('usage error is 64 (EX_USAGE on BSD sysexits)', () => {
    assert.equal(ExitCode.usage, 64)
  })

  test('missing PG_CONNECTION_STRING is 65 (EX_DATAERR)', () => {
    assert.equal(ExitCode.missingConnString, 65)
  })

  test('schema version drift is 70 (EX_SOFTWARE)', () => {
    assert.equal(ExitCode.schemaVersionDrift, 70)
  })

  test('network failure is 75 (EX_TEMPFAIL)', () => {
    assert.equal(ExitCode.networkFailure, 75)
  })

  test('internal error is 1', () => {
    assert.equal(ExitCode.internalError, 1)
  })

  test('the ExitCode object is frozen (no in-place rewrite)', () => {
    assert.ok(Object.isFrozen(ExitCode), 'ExitCode must be frozen')
  })
})

// ---------------------------------------------------------------------------
// render — pure human-readable summary for plan + apply results.
// ---------------------------------------------------------------------------

describe('render', () => {
  const planList: Migration[] = [
    { file: '0001_initial.sql', sql: '' },
    { file: '0002_rls.sql', sql: '' },
    { file: '0003_biz_key.sql', sql: '' },
    { file: '0004_ensure_attributes.sql', sql: '' },
  ]

  test('renders a plan list with file bullets', () => {
    const output = render(planList)
    assert.match(output, /Found 4 migration file\(s\)/)
    assert.match(output, /0001_initial\.sql/)
    assert.match(output, /0002_rls\.sql/)
    assert.match(output, /0003_biz_key\.sql/)
    assert.match(output, /0004_ensure_attributes\.sql/)
  })

  test('renders an empty plan list with zero count', () => {
    const output = render([])
    assert.match(output, /Found 0 migration file\(s\)/)
  })

  test('renders an apply result with applied/skipped/recorded sections', () => {
    const recorded = new Map<string, string>([
      ['0001_initial.sql', 'aaa'],
      ['0002_rls.sql', 'bbb'],
      ['0003_biz_key.sql', 'ccc'],
    ])
    const output = render({
      applied: ['0004_ensure_attributes.sql'],
      skipped: ['0001_initial.sql', '0002_rls.sql', '0003_biz_key.sql'],
      recorded,
    })
    assert.match(output, /Applied: 1/)
    assert.match(output, /\+ 0004_ensure_attributes\.sql/)
    assert.match(output, /Skipped \(already at checksum\): 3/)
    assert.match(output, /Recorded total: 3/)
  })
})

// ---------------------------------------------------------------------------
// printHelp — long-form help banner.
// ---------------------------------------------------------------------------

describe('printHelp', () => {
  test('includes the synopsis and flag descriptions', () => {
    const help = printHelp()
    assert.match(help, /dsh-migrate-multiuser/)
    assert.match(help, /--plan/)
    assert.match(help, /--run/)
    assert.match(help, /--connection/)
    assert.match(help, /--schema/)
    assert.match(help, /-h, --help/)
    assert.match(help, /Exit codes/)
  })

  test('lists every conventional exit code', () => {
    const help = printHelp()
    assert.match(help, /\b64\b/)
    assert.match(help, /\b65\b/)
    assert.match(help, /\b70\b/)
    assert.match(help, /\b75\b/)
  })
})
