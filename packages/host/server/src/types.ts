/**
 * Type definitions for `@deepseek-ai/dsh-host-server`.
 *
 * The server exposes the `/mu/v1/*` control-plane surface mounted on top of
 * {@link WebServer} (defined in `@deepseek-ai/dsh-host-webserver`). Every
 * shared piece — the in-flight request envelope, the structured route
 * spec, the bearer-token middleware outcome — lives here so handlers and
 * the registration glue all agree on one vocabulary.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A `/mu/v1/*` route registration: a kind, a path, the exact scopes the
 * bearer must hold, and the handler that owns the response.
 */
export interface MuRoute {
  /** HTTP method. Only `GET` and `POST` are used by `/mu/v1/*`. */
  readonly method: 'GET' | 'POST'
  /** Absolute pathname, no trailing slash. Path params (e.g. `{type}`) are matched exactly by the registration. */
  readonly path: string
  /** Scopes the Bearer token must hold (subset check). */
  readonly requiredScopes: readonly string[]
  /** Owns the response lifecycle. Called only after `Authorization` and scope checks pass. */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/**
 * Outcome of the Bearer-token middleware.
 *
 * `auth:ed` requests may proceed; `unauthenticated` and `forbidden`
 * answer the client immediately (401 / 403) before the handler runs.
 */
export type BearerOutcome =
  | { readonly kind: 'authed'; readonly subject: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string }

/**
 * Materialized tenant context. The X-Dsh-Tenant header is read once, by
 * the middleware, and frozen into this object before the handler runs.
 */
export interface RequestTenantContext {
  readonly tenantId: string
  /** Optional trace id from `X-Dsh-Trace-Id`; generated when absent. */
  readonly traceId: string
}
