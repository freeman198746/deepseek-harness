/**
 * `GET /mu/v1/health` — public health probe for the `/mu/v1/*` control
 * plane. The endpoint deliberately does NOT require a bearer token so a
 * load balancer can hit it without a credential. It echoes whether the
 * mounted {@link PgStoreService} answered a `SELECT 1` round-trip within
 * the supplied timeout (default 2s).
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PgStoreService } from '@deepseek-ai/dsh-storage-postgres'
import { writeOk, writeError } from '../http.ts'
import { ServerError } from '../error.ts'

/**
 * Build the `GET /mu/v1/health` handler.
 *
 * @param pgstore - The mounted {@link PgStoreService}; pinged with `SELECT 1`.
 * @returns The HTTP handler (signature compatible with `WebServer.register`).
 */
export function makeHealthHandler(pgstore: PgStoreService) {
  return async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const probe = await Promise.race([
        pgstore.client.query('SELECT 1 AS ok'),
        new Promise<never>((_, reject) => {
          setTimeout(() => { reject(new Error('health probe timeout')) }, 2000)
        }),
      ])
      const rows = (probe as { rows?: Array<{ ok: number }> }).rows
      writeOk(res, 200, {
        status: rows !== undefined && rows[0]?.ok === 1 ? 'ok' : 'degraded',
        service: 'dsh-host-server',
        pgstore: 'reachable',
      })
    } catch (error) {
      writeError(res, new ServerError(
        'upstream-unavailable',
        'pgstore ping failed',
        { cause: error },
      ))
    }
  }
}
