/**
 * Three-prefix biz_key validator for the host-side reverse-lookup family.
 *
 * The convention (decision point ⑥ in the multi-tenant plan) reserves three
 * namespaces — `aims.*` / `patient.*` / `visit.*` — that partition the host
 * business keys. This module only validates the *shape*: it confirms the
 * key starts with one of the three prefixes followed by a dot and a host
 * identifier, and that the prefix matches the {@link LookupType} being
 * requested. The host decides what the post-dot payload means.
 *
 * The function is deliberately side-effect free; it returns either a parsed
 * {@link BizKey} or throws a {@link LookupError} with `invalid-biz-key`.
 *
 * @module @deepseek-ai/dsh-host-lookup
 */

import { LookupError } from './error.ts'
import type { BizKey, BizKeyPrefix, LookupType } from './types.ts'

/** Frozen prefix table — keyed by {@link LookupType}. */
export const BIZ_KEY_PREFIX_BY_TYPE: Readonly<Record<LookupType, BizKeyPrefix>> =
  Object.freeze({
    user: 'aims',
    workspace: 'patient',
    session: 'visit',
  })

/**
 * The accepted prefix strings, in declaration order. Useful for diagnostics
 * (the error message lists what the host could have meant).
 */
export const BIZ_KEY_PREFIXES: readonly BizKeyPrefix[] =
  Object.freeze(['aims', 'patient', 'visit'])

/**
 * Validate a biz_key and tie its prefix to the requested {@link LookupType}.
 *
 * Returns the same string, branded as {@link BizKey}, when validation
 * succeeds. Throws a {@link LookupError} with `invalid-biz-key` otherwise.
 *
 * @param candidate - The untrusted string the host supplied.
 * @param type - The lookup category; its prefix must equal the key's prefix.
 * @returns The validated {@link BizKey}.
 */
export function validateBizKey(candidate: string, type: LookupType): BizKey {
  const expectedPrefix = BIZ_KEY_PREFIX_BY_TYPE[type]
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new LookupError('invalid-biz-key',
      `biz_key must be a non-empty string; received ${typeof candidate === 'string' ? `"${candidate}"` : typeof candidate}`,
    )
  }
  const dotIndex = candidate.indexOf('.')
  if (dotIndex <= 0 || dotIndex === candidate.length - 1) {
    throw new LookupError('invalid-biz-key',
      `biz_key must follow "<prefix>.<host-id>"; received "${candidate}"`,
    )
  }
  const prefix = candidate.slice(0, dotIndex)
  if (!BIZ_KEY_PREFIXES.includes(prefix as BizKeyPrefix)) {
    throw new LookupError('invalid-biz-key',
      `biz_key prefix "${prefix}" is not one of ${BIZ_KEY_PREFIXES.join(' / ')}`,
    )
  }
  if (prefix !== expectedPrefix) {
    throw new LookupError('invalid-biz-key',
      `biz_key prefix "${prefix}" does not match type "${type}" (expected "${expectedPrefix}")`,
    )
  }
  return candidate as BizKey
}

/**
 * Extract the prefix from a biz_key string without performing any
 * consistency check against a {@link LookupType}. Used when the host wants
 * to *learn* which prefix a key carries (for example to dispatch on type).
 *
 * @param candidate - The untrusted string the host supplied.
 * @returns The parsed {@link BizKeyPrefix}.
 */
export function extractBizKeyPrefix(candidate: string): BizKeyPrefix {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new LookupError('invalid-biz-key',
      `biz_key must be a non-empty string; received ${typeof candidate === 'string' ? `"${candidate}"` : typeof candidate}`,
    )
  }
  const dotIndex = candidate.indexOf('.')
  if (dotIndex <= 0 || dotIndex === candidate.length - 1) {
    throw new LookupError('invalid-biz-key',
      `biz_key must follow "<prefix>.<host-id>"; received "${candidate}"`,
    )
  }
  const prefix = candidate.slice(0, dotIndex)
  if (!BIZ_KEY_PREFIXES.includes(prefix as BizKeyPrefix)) {
    throw new LookupError('invalid-biz-key',
      `biz_key prefix "${prefix}" is not one of ${BIZ_KEY_PREFIXES.join(' / ')}`,
    )
  }
  return prefix as BizKeyPrefix
}