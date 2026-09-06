/**
 * Offline smoke for `@deepseek-ai/dsh-host-server`.
 *
 * Validates:
 *   1. middleware.checkBearer for 5 header states
 *   2. http.readJsonBody parsing + 16 KiB cap
 *   3. error.ServerError.statusFor mapping
 *   4. handler factories emit JSON responses with the right status + body
 *   5. handlers delegate to injected dependencies (fakes)
 *
 * No PG, no real WebServer; the smoke composes plain Node http fixtures.
 *
 * Run via:
 *   pnpm install --frozen-lockfile --offline   # resolves @types/node etc
 *   node --import tsx .workbuddy/smoke.ts
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ServerError,
  isServerError,
  assertBearer,
  checkBearer,
  TENANT_HEADER,
  TRACE_HEADER,
  makeEnsureHandler,
  makeHealthHandler,
  makeLookupHandler,
  makeTokenHandler,
  readJsonBody,
  writeJson,
  writeOk,
  writeError,
} from '../src/index.ts'

const API_KEY = 'machine-channel-secret-32-chars-long-xx'
let passed = 0
const fail = (msg: string, err: unknown): never => {
  console.error(`\n  ✗ ${msg}`)
  console.error(err)
  process.exitCode = 1
  throw err
}
const ok = (label: string): void => {
  console.log(`  ✓ ${label}`)
  passed += 1
}

// ---------------------------------------------------------------------------
// Tiny in-memory response spy.
// ---------------------------------------------------------------------------

interface CapturedResponse {
  status?: number
  headers: Record<string, string | number>
  body: string
  end(chunk?: string | Buffer): void
  writeHead(s: number, h?: Record<string, string | number>): void
  destroy(): void
}
function captureResponse(): { res: ServerResponse, captured: CapturedResponse } {
  const captured: CapturedResponse = {
    headers: {},
    body: '',
    writeHead(s, h = {}) {
      this.status = s
      this.headers = h
    },
    end(chunk) {
      this.status ??= 200
      if (chunk !== undefined) {
        this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      }
    },
    destroy() { /* noop */ },
  }
  return { res: captured as unknown as ServerResponse, captured }
}

// ---------------------------------------------------------------------------
// Tiny Readable that fakes an IncomingMessage body stream.
// ---------------------------------------------------------------------------

function fakeRequest(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const req = Readable.from(
    opts.body === undefined ? [] : [opts.body],
  ) as unknown as IncomingMessage
  Object.defineProperty(req, 'method', { value: opts.method ?? 'GET' })
  Object.defineProperty(req, 'url', { value: opts.url ?? '/' })
  Object.defineProperty(req, 'headers', { value: opts.headers ?? {} })
  return req
}

// ---------------------------------------------------------------------------
// 1. middleware.checkBearer
// ---------------------------------------------------------------------------

console.log('\n[1] middleware.checkBearer')
const bearerAccept = checkBearer(`Bearer ${API_KEY}`, API_KEY)
assert.equal(bearerAccept.kind, 'authed')
ok('match returns authed')
const bearerNoHeader = checkBearer(undefined, API_KEY)
assert.equal(bearerNoHeader.kind, 'unauthenticated')
ok('missing header returns unauthenticated')
const bearerWrongHeader = checkBearer(`Basic ${API_KEY}`, API_KEY)
assert.equal(bearerWrongHeader.kind, 'malformed')
ok('non-Bearer scheme returns malformed')
const bearerWrongSecret = checkBearer(`Bearer wrong-secret-1234567890`, API_KEY)
assert.equal(bearerWrongSecret.kind, 'unauthenticated')
ok('wrong secret returns unauthenticated')
const bearerEmptyHeader = checkBearer('', API_KEY)
assert.equal(bearerEmptyHeader.kind, 'unauthenticated')
ok('empty header returns unauthenticated')

assertBearer(bearerAccept)
ok('assertBearer accepts authed without throw')

// ---------------------------------------------------------------------------
// 2. http.readJsonBody + writeJson + writeOk + writeError
// ---------------------------------------------------------------------------

console.log('\n[2] http helpers')
{
  const req = fakeRequest({ body: '{"a":1,"b":2}' })
  const parsed = await readJsonBody(req)
  assert.deepEqual(parsed, { a: 1, b: 2 })
  ok('readJsonBody parses valid JSON')
}
{
  const req = fakeRequest({ body: '' })
  const parsed = await readJsonBody(req)
  assert.equal(parsed, undefined)
  ok('readJsonBody returns undefined for empty body')
}
{
  const req = fakeRequest({ body: 'this-is-not-json' })
  await assert.rejects(() => readJsonBody(req), (e: unknown) => isServerError(e) && e.code === 'bad-request')
  ok('readJsonBody rejects malformed JSON with bad-request')
}
{
  // 17 KiB body — should trip the 16 KiB cap
  const oversized = 'a'.repeat(17 * 1024)
  const req = fakeRequest({ body: oversized })
  await assert.rejects(() => readJsonBody(req),
    (e: unknown) => isServerError(e) && e.message.includes('exceeds'))
  ok('readJsonBody rejects oversize body')
}
{
  const { res, captured } = captureResponse()
  writeJson(res, 201, { x: 1 })
  assert.equal(captured.status, 201)
  assert.match(captured.headers['content-type'] as string, /application\/json/)
  assert.match(captured.body, /"x":1/)
  ok('writeJson emits JSON content-type + body')
}
{
  const { res, captured } = captureResponse()
  writeOk(res, 200, { foo: 'bar' })
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"ok":true/)
  assert.match(captured.body, /"foo":"bar"/)
  ok('writeOk wraps payload in { ok: true }')
}
{
  const { res, captured } = captureResponse()
  writeError(res, new ServerError('not-found', 'no row'))
  assert.equal(captured.status, 404)
  assert.match(captured.body, /"ok":false/)
  assert.match(captured.body, /"code":"not-found"/)
  ok('writeError emits JSON error envelope')
}

// ---------------------------------------------------------------------------
// 3. ServerError.statusFor mapping
// ---------------------------------------------------------------------------

console.log('\n[3] ServerError.statusFor')
assert.equal(ServerError.statusFor('unauthenticated'), 401)
assert.equal(ServerError.statusFor('forbidden'), 403)
assert.equal(ServerError.statusFor('not-found'), 404)
assert.equal(ServerError.statusFor('bad-request'), 400)
assert.equal(ServerError.statusFor('conflict'), 409)
assert.equal(ServerError.statusFor('upstream-unavailable'), 503)
assert.equal(ServerError.statusFor('internal-error'), 500)
ok('all seven codes map to expected statuses')

const niceCause = new ServerError('internal-error', 'boom', { cause: 'underlying' })
assert.equal((niceCause as Error & { cause?: unknown }).cause, 'underlying')
ok('ServerError preserves cause option')

// ---------------------------------------------------------------------------
// 4. handlers/health with a fake pgstore
// ---------------------------------------------------------------------------

console.log('\n[4] handlers/health')
{
  const fakePg = {
    client: {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT 1')) return { rows: [{ ok: 1 }] }
        return { rows: [] }
      },
    },
  }
  const handler = makeHealthHandler(fakePg as never)
  const { res, captured } = captureResponse()
  await handler(fakeRequest({}), res)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"status":"ok"/)
  ok('health returns 200 / status=ok when pgstore responds')
}
{
  const fakePgBroken = {
    client: {
      query: async () => { throw new Error('connection refused') },
    },
  }
  const handler = makeHealthHandler(fakePgBroken as never)
  const { res, captured } = captureResponse()
  await handler(fakeRequest({}), res)
  assert.equal(captured.status, 503)
  assert.match(captured.body, /"code":"upstream-unavailable"/)
  ok('health returns 503 when pgstore throws')
}

// ---------------------------------------------------------------------------
// 5. handlers/lookup with a fake LookupService
// ---------------------------------------------------------------------------

console.log('\n[5] handlers/lookup')
const fakeLookup = (lookupImpl: (type: string, bizKey: string) => Promise<unknown>) => ({
  lookup: async (_ctx: unknown, type: string, bizKey: string) => lookupImpl(type, bizKey),
  ensure: async () => { throw new Error('not used') },
})
{
  const handler = makeLookupHandler({
    apiKey: API_KEY,
    lookup: fakeLookup(async () => ({
      kind: 'hit',
      record: {
        id: 'u-123',
        bizKey: 'aims.D2024001',
        tenantId: '00000000-0000-0000-0000-000000000001',
        createdAt: new Date('2026-09-06T00:00:00Z'),
        updatedAt: new Date('2026-09-06T00:00:00Z'),
      },
    })) as never,
  })
  const req = fakeRequest({
    method: 'GET',
    url: '/mu/v1/lookup?type=user&biz_key=aims.D2024001',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001',
    },
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"hit":/)
  assert.match(captured.body, /"id":"u-123"/)
  ok('lookup hit: 200 + body contains hit envelope')
}
{
  const handler = makeLookupHandler({
    apiKey: API_KEY,
    lookup: fakeLookup(async () => ({ kind: 'miss' })) as never,
  })
  const req = fakeRequest({
    method: 'GET',
    url: '/mu/v1/lookup?type=workspace&biz_key=patient.ABC123',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001',
    },
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"miss":true/)
  ok('lookup miss: 200 + body contains miss envelope')
}
{
  const handler = makeLookupHandler({
    apiKey: API_KEY,
    lookup: fakeLookup(async () => ({ kind: 'miss' })) as never,
  })
  // No tenant header → bad-request
  const req = fakeRequest({
    method: 'GET',
    url: '/mu/v1/lookup?type=workspace&biz_key=patient.ABC123',
    headers: { authorization: `Bearer ${API_KEY}` },
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 400)
  assert.match(captured.body, /"code":"bad-request"/)
  ok('lookup without tenant: 400 bad-request')
}
{
  const handler = makeLookupHandler({
    apiKey: API_KEY,
    lookup: fakeLookup(async () => ({ kind: 'miss' })) as never,
  })
  // No bearer at all
  const req = fakeRequest({
    method: 'GET',
    url: '/mu/v1/lookup?type=workspace&biz_key=patient.ABC123',
    headers: { [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001' },
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 401)
  assert.match(captured.body, /"code":"unauthenticated"/)
  ok('lookup without bearer: 401 unauthenticated')
}
{
  const handler = makeLookupHandler({
    apiKey: API_KEY,
    lookup: fakeLookup(async () => ({ kind: 'miss' })) as never,
  })
  // Bad type
  const req = fakeRequest({
    method: 'GET',
    url: '/mu/v1/lookup?type=junk&biz_key=abc',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001',
    },
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 400)
  assert.match(captured.body, /type must be one of/)
  ok('lookup with bad type: 400 bad-request')
}

// ---------------------------------------------------------------------------
// 6. handlers/ensure happy + header mismatch
// ---------------------------------------------------------------------------

console.log('\n[6] handlers/ensure')
{
  const handler = makeEnsureHandler('workspace', {
    apiKey: API_KEY,
    lookup: {
      lookup: async () => { throw new Error('not used') },
      ensure: async () => ({
        id: 'ws-9',
        bizKey: 'patient.ABC123',
        tenantId: '00000000-0000-0000-0000-000000000001',
        createdAt: new Date('2026-09-06T00:00:00Z'),
        updatedAt: new Date('2026-09-06T00:00:00Z'),
      }),
    } as never,
  })
  const req = fakeRequest({
    method: 'POST',
    url: '/mu/v1/ensure/workspace',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001',
      [TRACE_HEADER]: '11111111-2222-3333-4444-555555555555',
    },
    body: JSON.stringify({
      bizKey: 'patient.ABC123',
      tenantId: '00000000-0000-0000-0000-000000000001',
    }),
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"id":"ws-9"/)
  ok('ensure happy path: 200 + body contains upserted row')
}
{
  const handler = makeEnsureHandler('user', {
    apiKey: API_KEY,
    lookup: {
      lookup: async () => { throw new Error('not used') },
      ensure: async () => {
        throw new Error('should not be reached when header mismatches')
      },
    } as never,
  })
  const req = fakeRequest({
    method: 'POST',
    url: '/mu/v1/ensure/user',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      [TENANT_HEADER]: '00000000-0000-0000-0000-000000000001',
    },
    body: JSON.stringify({
      bizKey: 'aims.D2024001',
      tenantId: '00000000-0000-0000-0000-000000000999',  // mismatch
    }),
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 400)
  assert.match(captured.body, /must match body.tenantId/)
  ok('ensure header/body tenant mismatch: 400 bad-request')
}

// ---------------------------------------------------------------------------
// 7. handlers/token (mints a JWT)
// ---------------------------------------------------------------------------

console.log('\n[7] handlers/token')
{
  const fakeAuth = {
    audience: 'dsh-apiproxy',
    mint: async (opts: { subject: string; scopes?: readonly string[] }) => ({
      token: `signed.${opts.subject}.${(opts.scopes ?? []).join(',')}`,
      jti: 'jti-123',
      expiresAt: new Date('2026-09-06T01:00:00Z'),
      keyId: 'k1',
    }),
  }
  const handler = makeTokenHandler({ apiKey: API_KEY, auth: fakeAuth as never })
  const req = fakeRequest({
    method: 'POST',
    url: '/mu/v1/auth/token:issue',
    headers: { authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ subject: 'tenant-1.user-1', scopes: ['lookup:read'] }),
  })
  const { res, captured } = captureResponse()
  await handler(req, res)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /"token":/)
  assert.match(captured.body, /"jti":"jti-123"/)
  assert.match(captured.body, /"expiresAt":/)
  ok('token:issue happy path: 200 + minted envelope')
}

// ---------------------------------------------------------------------------
console.log(`\nAll ${passed} assertions passed.`)
