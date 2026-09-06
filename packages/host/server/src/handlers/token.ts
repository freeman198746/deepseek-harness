/**
 * `POST /mu/v1/auth/token:issue` — machine-channel token issuance. The
 * endpoint accepts an authenticated machine caller (Bearer = API key)
 * holding the `auth:issue` scope and mints a short-lived user JWT that
 * the iframe side can present to the deepseek-harness apiproxy.
 *
 * Body shape:
 *
 * ```jsonc
 * {
 *   "subject":  "<tenantId>.<userId>",   // required
 *   "scopes":   ["lookup:read"],         // optional, default []
 *   "audience": "dsh-apiproxy",          // optional, default configured
 *   "ttlSeconds": 3600                   // optional, default configured
 * }
 * ```
 *
 * Response: `{ ok: true, token, jti, expiresAt, audience }`.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthService } from '@deepseek-ai/dsh-host-auth'
import { assertBearer, checkBearer } from '../middleware.ts'
import { readJsonBody, writeOk, writeError } from '../http.ts'
import { ServerError } from '../error.ts'

/**
 * Validate the `/auth/token:issue` body.
 *
 * @param body - Parsed JSON.
 * @returns Validated `{ subject, scopes, audience, ttlSeconds }`.
 * @throws {@link ServerError} 400 when the body is wrong.
 */
function validateTokenBody(body: unknown): {
  subject: string
  scopes: readonly string[]
  audience: string | undefined
  ttlSeconds: number | undefined
} {
  if (typeof body !== 'object' || body === null) {
    throw new ServerError('bad-request', 'body must be a JSON object')
  }
  const obj = body as Record<string, unknown>
  const subject = obj['subject']
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new ServerError('bad-request', 'subject is required')
  }
  const scopes = obj['scopes']
  if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string'))) {
    throw new ServerError('bad-request', 'scopes must be a string[] when provided')
  }
  const audience = obj['audience']
  if (audience !== undefined && typeof audience !== 'string') {
    throw new ServerError('bad-request', 'audience must be a string when provided')
  }
  const ttlRaw = obj['ttlSeconds']
  if (ttlRaw !== undefined && (typeof ttlRaw !== 'number' || !Number.isFinite(ttlRaw) || ttlRaw <= 0)) {
    throw new ServerError('bad-request', 'ttlSeconds must be a positive number when provided')
  }
  return {
    subject,
    scopes: scopes === undefined ? [] : scopes as string[],
    audience: audience as string | undefined,
    ttlSeconds: ttlRaw as number | undefined,
  }
}

/**
 * Build the `POST /mu/v1/auth/token:issue` handler.
 *
 * @param deps - Wiring: the auth service and the bearer secret.
 * @returns The HTTP handler.
 */
export function makeTokenHandler(deps: {
  readonly auth: AuthService
  readonly apiKey: string
}) {
  return async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Step 1 — bearer check.
      assertBearer(checkBearer(req.headers['authorization'], deps.apiKey))

      // Step 2 — body + validation.
      const body = await readJsonBody(req)
      const { subject, scopes, audience, ttlSeconds } = validateTokenBody(body)

      // Step 3 — mint.
      const minted = await deps.auth.mint({
        subject,
        scopes,
        ...(audience !== undefined ? { audience } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      })

      // Step 4 — write response.
      writeOk(res, 200, {
        token: minted.token,
        jti: minted.jti,
        expiresAt: minted.expiresAt.toISOString(),
        audience: audience ?? (deps.auth as unknown as { audience: string }).audience
          ?? 'default',
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
