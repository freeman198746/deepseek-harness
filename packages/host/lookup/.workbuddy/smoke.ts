// Smoke check for the biz-key validator — runs without vitest so we can
// validate the host-lookup package before the full vitest harness
// recognises it. Mirrors the vitest contract suite in
// `tests/contract.spec.ts`:
//   * validateBizKey accepts well-formed keys whose prefix matches the type
//   * validateBizKey rejects empty / non-string / prefix-less / unknown-prefix
//     / cross-type-prefix inputs with LookupError code 'invalid-biz-key'
//   * extractBizKeyPrefix returns the prefix without checking the type
//
// Run from the dsh repo root:
//   node --import tsx packages/host/lookup/.workbuddy/smoke.ts

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  BIZ_KEY_PREFIX_BY_TYPE,
  BIZ_KEY_PREFIXES,
  extractBizKeyPrefix,
  validateBizKey,
} from '../src/biz-key.ts'
import { LookupError } from '../src/error.ts'

function expectThrowsInvalidBizKey(label: string, run: () => unknown): void {
  try {
    run()
  } catch (err) {
    assert.ok(err instanceof LookupError, `${label}: expected LookupError, got ${err}`)
    assert.equal(err.code, 'invalid-biz-key', `${label}: expected code 'invalid-biz-key', got ${err.code}`)
    console.log(`OK ${label}`)
    return
  }
  assert.fail(`${label}: expected LookupError, got nothing`)
}

assert.equal(BIZ_KEY_PREFIX_BY_TYPE.user, 'aims')
assert.equal(BIZ_KEY_PREFIX_BY_TYPE.workspace, 'patient')
assert.equal(BIZ_KEY_PREFIX_BY_TYPE.session, 'visit')
console.log('OK prefix table (user/workspace/session → aims/patient/visit)')

assert.deepEqual([...BIZ_KEY_PREFIXES], ['aims', 'patient', 'visit'])
console.log('OK frozen prefix list (aims / patient / visit)')

assert.equal(validateBizKey('aims.alice', 'user'), 'aims.alice')
assert.equal(validateBizKey('patient.abc.def', 'workspace'), 'patient.abc.def')
assert.equal(validateBizKey('visit.visit-1', 'session'), 'visit.visit-1')
console.log('OK validate accepts matching prefix')

expectThrowsInvalidBizKey('rejects empty', () => validateBizKey('', 'user'))
expectThrowsInvalidBizKey('rejects missing prefix', () => validateBizKey('alice', 'user'))
expectThrowsInvalidBizKey('rejects empty host-id', () => validateBizKey('aims.', 'user'))
expectThrowsInvalidBizKey('rejects unknown prefix', () => validateBizKey('foo.bar', 'user'))
expectThrowsInvalidBizKey('rejects aims→workspace', () => validateBizKey('aims.alice', 'workspace'))
expectThrowsInvalidBizKey('rejects patient→user', () => validateBizKey('patient.cureno', 'user'))
expectThrowsInvalidBizKey('rejects visit→user', () => validateBizKey('visit.visit-1', 'user'))
expectThrowsInvalidBizKey('rejects aims→session', () => validateBizKey('aims.alice', 'session'))
expectThrowsInvalidBizKey('rejects visit→workspace', () => validateBizKey('visit.visit-1', 'workspace'))
expectThrowsInvalidBizKey('rejects patient→session', () => validateBizKey('patient.cureno', 'session'))

assert.equal(extractBizKeyPrefix('aims.alice'), 'aims')
assert.equal(extractBizKeyPrefix('patient.cureno'), 'patient')
assert.equal(extractBizKeyPrefix('visit.visit-1'), 'visit')
console.log('OK extractBizKeyPrefix returns the prefix')

expectThrowsInvalidBizKey('extract rejects empty', () => extractBizKeyPrefix(''))
expectThrowsInvalidBizKey('extract rejects no-dot', () => extractBizKeyPrefix('nodot'))
expectThrowsInvalidBizKey('extract rejects empty host-id', () => extractBizKeyPrefix('aims.'))
expectThrowsInvalidBizKey('extract rejects unknown prefix', () => extractBizKeyPrefix('unknown.foo'))

// Resolve path constants used in the test (silence unused-import warnings).
void path
void fileURLToPath

console.log('ALL CHECKS PASSED')