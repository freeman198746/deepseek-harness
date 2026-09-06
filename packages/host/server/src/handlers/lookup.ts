/**
 * `GET /mu/v1/lookup` — reverse-lookup handler that proxies a host-side
 * `biz_key` resolution through {@link LookupService}.
 *
 * The endpoint accepts the three query parameters:
 *
 *   `type`       ∈ {`user`, `workspace`, `session`} — required
 *   `biz_key`    string (validated against `type`'s prefix) — required
 *   `tenant_key` string — required (the request *must* carry a tenant)
 *
 * Returns either `{ ok: true, hit: <record> }` or `{ ok: true, miss: true }`.
 * The lookup body itself is the shape described in
 * `@deepseek-ai/dsh-host-lookup`'s `LookupOutcome`; this handler just
 * passes it through.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { LookupService } from '@deepseek-ai/dsh-host-lookup'
import type { LookupType } from '@deepseek-ai/dsh-host-lookup/types.ts'
import {
  TENANT_HEADER,
  TRACE_HEADER,
  assertBearer,
  checkBearer,
} from '../middleware.ts'
import { writeOk, writeError } from '../http.ts'
import { ServerError } from '../error.ts'

const VALID_TYPES: ReadonlySet<LookupType> = new Set<LookupType>([
  'user', 'workspace', 'session',
])

/**
 * Build the `GET /mu/v1/lookup` handler.
 *
 * @param deps - Wiring: the looker and the bearer secret.
 * @returns The HTTP handler.
 */
export function makeLookupHandler(deps: {
  readonly lookup: LookupService
  readonly apiKey: string
}) {
  return async function handleLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Step 1 — bearer check (machine API key).
      assertBearer(checkBearer(req.headers['authorization'], deps.apiKey))

      // Step 2 — parse query string.
      const url = new URL(req.url ?? '/mu/v1/lookup', 'http://x')
      const type = url.searchParams.get('type') ?? ''
      const bizKey = url.searchParams.get('biz_key') ?? ''
      const tenantId = (req.headers[TENANT_HEADER] as string | undefined)
        ?? url.searchParams.get('tenant_key')
        ?? ''
      const traceId = (req.headers[TRACE_HEADER] as string | undefined) ?? ''

      if (!VALID_TYPES.has(type as LookupType)) {
        throw new ServerError('bad-request', 'type must be one of user, workspace, session')
      }
      if (typeof bizKey !== 'string' || bizKey.length === 0) {
        throw new ServerError('bad-request', 'biz_key is required')
      }
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new ServerError('bad-request',
          'tenant is required (X-Dsh-Tenant header or tenant_key query parameter)',
        )
      }

      // Step 3 — call lookup.
      const outcome = await deps.lookup.lookup(
        { tenantId: tenantId as never, traceId: traceId.length > 0 ? traceId : 'no-trace' },
        type as LookupType,
        bizKey,
      )

      // Step 4 — write response.
      if (outcome.kind === 'miss') {
        writeOk(res, 200, { miss: true, type, bizKey, tenantId })
        return
      }
      writeOk(res, 200, {
        hit: {
          type,
          id: outcome.record.id,
          bizKey: outcome.record.bizKey,
          tenantId: outcome.record.tenantId,
          createdAt: outcome.record.createdAt.toISOString(),
          updatedAt: outcome.record.updatedAt.toISOString(),
        },
      })
    } catch (error) {
      if (error instanceof ServerError) {
        writeError(res, error)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      writeError(res, new ServerError(
        // Postgres UNIQUE violation / lookup miss raised as a lookup error code
        // falls through to "not-found" because the orchestrator already returned
        // a miss envelope — only true exceptions land here.
        message.includes('not found') || message.includes('NotFound') ? 'not-found' : 'internal-error',
        message,
        { cause: error },
      ))
    }
  }
}
