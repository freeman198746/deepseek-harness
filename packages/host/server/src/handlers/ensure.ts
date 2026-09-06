/**
 * `POST /mu/v1/ensure/{type}` — idempotent upsert for the lookup family.
 * The `{type}` path parameter is one of `user`, `workspace`, `session`.
 *
 * Body shape:
 *
 * ```jsonc
 * {
 *   "bizKey": "patient.ABC123",      // required, validated against type
 *   "tenantId": "<uuid>",            // required
 *   "attrs": { ... }                 // optional, written on insert
 * }
 * ```
 *
 * The response is the same shape as the `lookup` hit envelope. The
 * ensure call is the *write* sibling of `lookup`; once a row exists,
 * subsequent calls return the existing row and never touch `attrs`.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LookupService } from '@deepseek-ai/dsh-host-lookup'
import type { LookupType } from '@deepseek-ai/dsh-host-lookup/types.ts'
import {
  TENANT_HEADER,
  TRACE_HEADER,
  assertBearer,
  checkBearer,
} from '../middleware.ts'
import { readJsonBody, writeOk, writeError } from '../http.ts'
import { ServerError } from '../error.ts'

const VALID_TYPES: ReadonlySet<LookupType> = new Set<LookupType>([
  'user', 'workspace', 'session',
])

/**
 * Validate that the body has the expected ensure shape.
 *
 * @param body - The parsed JSON body.
 * @returns Validated `{ type, bizKey, tenantId, attrs? }`.
 * @throws {@link ServerError} 400 when the shape is wrong.
 */
function validateEnsureBody(body: unknown, type: LookupType): {
  bizKey: string
  tenantId: string
  attrs: Record<string, unknown> | undefined
} {
  if (typeof body !== 'object' || body === null) {
    throw new ServerError('bad-request', 'body must be a JSON object')
  }
  const obj = body as Record<string, unknown>
  const bizKey = obj['bizKey']
  const tenantId = obj['tenantId']
  const attrs = obj['attrs']
  if (typeof bizKey !== 'string' || bizKey.length === 0) {
    throw new ServerError('bad-request', 'bizKey is required')
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new ServerError('bad-request', 'tenantId is required')
  }
  if (attrs !== undefined && (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs))) {
    throw new ServerError('bad-request', 'attrs must be a plain object when provided')
  }
  return {
    bizKey,
    tenantId,
    attrs: attrs as Record<string, unknown> | undefined,
  }
}

/**
 * Build the `POST /mu/v1/ensure/{type}` handler for a fixed `{type}`.
 *
 * The factory exists so the route registration can mount three concrete
 * paths (`/mu/v1/ensure/user`, `/mu/v1/ensure/workspace`,
 * `/mu/v1/ensure/session`) without a runtime discriminator.
 *
 * @param type - The lookup type this handler is bound to.
 * @param deps - Wiring: the looker and the bearer secret.
 * @returns The HTTP handler.
 */
export function makeEnsureHandler(type: LookupType, deps: {
  readonly lookup: LookupService
  readonly apiKey: string
}) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`makeEnsureHandler: unknown type "${type}"`)
  }
  return async function handleEnsure(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Step 1 — bearer check.
      assertBearer(checkBearer(req.headers['authorization'], deps.apiKey))

      // Step 2 — header enforcement: tenant is required for ensure calls.
      const headerTenant = req.headers[TENANT_HEADER] as string | undefined
      if (typeof headerTenant !== 'string' || headerTenant.length === 0) {
        throw new ServerError('bad-request', 'X-Dsh-Tenant header is required for /ensure')
      }
      const traceId = (req.headers[TRACE_HEADER] as string | undefined) ?? ''

      // Step 3 — body + validation.
      const body = await readJsonBody(req)
      const { bizKey, tenantId, attrs } = validateEnsureBody(body, type)
      if (headerTenant !== tenantId) {
        throw new ServerError('bad-request',
          `X-Dsh-Tenant header (${headerTenant}) must match body.tenantId (${tenantId})`,
        )
      }

      // Step 4 — call ensure (idempotent upsert).
      const record = await deps.lookup.ensure(
        { tenantId: tenantId as never, traceId: traceId.length > 0 ? traceId : 'no-trace' },
        {
          type,
          tenantId: tenantId as never,
          bizKey: bizKey as never,
          ...(attrs !== undefined ? { attrs } : {}),
        },
      )

      // Step 5 — write response.
      writeOk(res, 200, {
        type,
        id: record.id,
        bizKey: record.bizKey,
        tenantId: record.tenantId,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      })
    } catch (error) {
      if (error instanceof ServerError) {
        writeError(res, error)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      writeError(res, new ServerError('internal-error', message, { cause: error }))
    }
  }
}
