/**
 * Contract tests for the host-lookup helpers. Validates biz-key parsing
 * and the stable prefix-by-type mapping without touching storage. The
 * real-PG e2e lives in {@link ./lookup.e2e.ts}.
 *
 * @module @deepseek-ai/dsh-host-lookup/contract
 */

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  BIZ_KEY_PREFIX_BY_TYPE,
  BIZ_KEY_PREFIXES,
  extractBizKeyPrefix,
  validateBizKey,
} from '../src/biz-key.ts'
import { LookupError } from '../src/error.ts'

describe('biz-key prefix table', () => {
  test('user maps to aims', () => {
    assert.equal(BIZ_KEY_PREFIX_BY_TYPE.user, 'aims')
  })

  test('workspace maps to patient', () => {
    assert.equal(BIZ_KEY_PREFIX_BY_TYPE.workspace, 'patient')
  })

  test('session maps to visit', () => {
    assert.equal(BIZ_KEY_PREFIX_BY_TYPE.session, 'visit')
  })

  test('prefix list freezes the three reserved namespaces', () => {
    assert.deepEqual([...BIZ_KEY_PREFIXES], ['aims', 'patient', 'visit'])
  })
})

describe('validateBizKey', () => {
  test('accepts a well-formed key whose prefix matches the type', () => {
    const result = validateBizKey('aims.alice', 'user')
    assert.equal(result, 'aims.alice')
  })

  test('accepts keys with dots in the host-id portion', () => {
    // patient.cureno (where cureno may itself contain dots) still parses.
    const result = validateBizKey('patient.abc.def', 'workspace')
    assert.equal(result, 'patient.abc.def')
  })

  test('rejects empty strings', () => {
    assert.throws(() => validateBizKey('', 'user'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects non-strings', () => {
    // @ts-expect-error — validateBizKey's contract is a string, the test
    // passes `undefined` to prove the type guard catches it.
    assert.throws(() => validateBizKey(undefined, 'user'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects missing prefix', () => {
    assert.throws(() => validateBizKey('alice', 'user'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects empty host-id portion', () => {
    assert.throws(() => validateBizKey('aims.', 'user'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects unknown prefixes', () => {
    assert.throws(() => validateBizKey('foo.bar', 'user'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects mismatched prefix-vs-type pairs', () => {
    // 'aims.*' is reserved for user; workspace expects 'patient.*'.
    assert.throws(() => validateBizKey('aims.alice', 'workspace'), (err: unknown) => {
      return err instanceof LookupError && err.code === 'invalid-biz-key'
    })
  })

  test('rejects each cross-prefix combination', () => {
    const cases: Array<[string, 'user' | 'workspace' | 'session']> = [
      ['patient.cureno', 'user'],
      ['visit.visit-123', 'user'],
      ['aims.alice', 'session'],
      ['visit.visit-123', 'workspace'],
      ['aims.alice', 'workspace'],
      ['patient.cureno', 'session'],
    ]
    for (const [candidate, type] of cases) {
      assert.throws(() => validateBizKey(candidate, type), (err: unknown) => {
        return err instanceof LookupError && err.code === 'invalid-biz-key'
      }, `expected ${candidate} to fail validation for ${type}`)
    }
  })
})

describe('extractBizKeyPrefix', () => {
  test('returns the prefix without checking the type', () => {
    assert.equal(extractBizKeyPrefix('aims.alice'), 'aims')
    assert.equal(extractBizKeyPrefix('patient.cureno'), 'patient')
    assert.equal(extractBizKeyPrefix('visit.visit-1'), 'visit')
  })

  test('rejects the same malformed shapes as validateBizKey', () => {
    assert.throws(() => extractBizKeyPrefix(''), LookupError)
    assert.throws(() => extractBizKeyPrefix('nodot'), LookupError)
    assert.throws(() => extractBizKeyPrefix('aims.'), LookupError)
    assert.throws(() => extractBizKeyPrefix('unknown.foo'), LookupError)
  })
})