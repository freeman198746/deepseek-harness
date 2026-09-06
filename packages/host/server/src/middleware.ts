/**
 * Bearer-token middleware for the `/mu/v1/*` control plane.
 *
 * The middleware is intentionally minimal: the server trusts one shared
 * secret (the "machine API key" delivered by the operator) and checks that
 * the request carries it under `Authorization: Bearer <key>`. A future
 * version can split the key into `(keyId, secret)` pairs and keep scopes
 * per pair; the surface {@link checkBearer} exposes today is shaped so
 * that swap stays a one-file edit.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import { timingSafeEqual } from 'node:crypto'
import { ServerError } from './error.ts'
import type { BearerOutcome } from './types.ts'

/** Header name carrying the bearer credential. */
export const AUTHORIZATION_HEADER = 'authorization'

/** Header name carrying the tenant scope for the request. */
export const TENANT_HEADER = 'x-dsh-tenant'

/** Header name carrying the per-request trace id. */
export const TRACE_HEADER = 'x-dsh-trace-id'

/**
 * Verify the `Authorization: Bearer <key>` header against the configured
 * shared secret. Comparison uses `timingSafeEqual` to avoid leaking match
 * progress over time.
 *
 * The middleware does NOT verify the (potentially JWT-shaped) credential;
 * that is the job of `ctx.auth.verify` for user tokens. The bearer in
 * front of `/mu/v1/*` is a single shared machine secret in v1.
 *
 * @param headerValue - The raw `Authorization` header value, or `undefined`.
 * @param expectedKey - The configured machine API key.
 * @returns The outcome envelope.
 */
export function checkBearer(headerValue: string | undefined, expectedKey: string): BearerOutcome {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { kind: 'unauthenticated', reason: 'missing Authorization header' }
  }
  const match = /^Bearer\s+(\S+)$/.exec(headerValue)
  if (match === null) {
    return { kind: 'malformed', reason: 'Authorization header must be "Bearer <key>"' }
  }
  const presented = match[1]!
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expectedKey, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { kind: 'unauthenticated', reason: 'Bearer token did not match' }
  }
  return { kind: 'authed', subject: 'machine' }
}

/**
 * Reject a {@link BearerOutcome} that is not `authed` by raising a
 * {@link ServerError}. Centralised so every route answers 401/400 the
 * same way.
 *
 * @param outcome - Outcome from {@link checkBearer}.
 * @throws {@link ServerError}
 */
export function assertBearer(outcome: BearerOutcome): asserts outcome is { kind: 'authed'; subject: string } {
  if (outcome.kind === 'unauthenticated') {
    throw new ServerError('unauthenticated', outcome.reason)
  }
  if (outcome.kind === 'malformed') {
    throw new ServerError('bad-request', outcome.reason)
  }
  if (outcome.kind === 'forbidden') {
    throw new ServerError('forbidden', outcome.reason)
  }
}
