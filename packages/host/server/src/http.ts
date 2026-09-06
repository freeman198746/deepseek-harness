/**
 * Low-level `IncomingMessage` / `ServerResponse` helpers for the JSON
 * surfaces exposed by `/mu/v1/*`. Centralised so every handler agrees on
 * one body-reading contract (cap, error code on overflow) and one
 * response contract (status + JSON body + content-type).
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { ServerError } from './error.ts'

/** Maximum request body length accepted by `/mu/v1/*` (16 KiB). */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Drain and JSON-parse the body of an incoming request.
 *
 * Caps total bytes at {@link MAX_BODY_BYTES}; anything larger fails with
 * `bad-request` (HTTP 400) so a single handler never trips the rest of
 * the request pipeline.
 *
 * @param req - Incoming HTTP message.
 * @returns The parsed JSON value (`unknown`); cast at the call site.
 * @throws {@link ServerError} `bad-request` when the body is empty, malformed, or oversized.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new ServerError(
        'bad-request',
        `request body exceeds ${MAX_BODY_BYTES} bytes`,
      )
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new ServerError(
      'bad-request',
      'request body is not valid JSON',
      { cause: error },
    )
  }
}

/**
 * Send a JSON response. Sets `Content-Type: application/json; charset=utf-8`
 * and uses `JSON.stringify` (which throws `TypeError` on circular structures
 * — fail fast before headers are flushed).
 *
 * @param res - HTTP response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable value.
 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json, 'utf8'),
  })
  res.end(json)
}

/**
 * Send a {@link ServerError} as a structured JSON body.
 *
 * @param res - HTTP response.
 * @param error - The error to surface.
 */
export function writeError(res: ServerResponse, error: ServerError): void {
  writeJson(res, error.httpStatus, {
    ok: false,
    code: error.code,
    message: error.message,
  })
}

/**
 * Send an ok response (`{ ok: true, ...data }`).
 *
 * @param res - HTTP response.
 * @param status - HTTP status code.
 * @param data - Extra fields merged into the response body.
 */
export function writeOk(res: ServerResponse, status: number, data: Record<string, unknown> = {}): void {
  writeJson(res, status, { ok: true, ...data })
}
