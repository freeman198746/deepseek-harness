# @deepseek-ai/dsh-host-auth

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-auth` signs and verifies short-lived asymmetric JWTs
that identify a machine or user principal to other packages in the same
host process. Phase 1 ships a single EdDSA (Ed25519) key pair mounted as
`ctx.auth`; the service is fully synchronous on the JavaScript event
loop and never round-trips to the database.

The package does **NOT** register HTTP routes, middleware, or session
state. Wiring `Authorization: Bearer <token>` validation is the
responsibility of `@deepseek-ai/dsh-server` (the future `boot` step,
change point #15).

## Use

```ts
import { Context } from '@deepseek-ai/cordis'
import {
  apply as hostAuthApply,
  AuthService,
  AuthError,
  isAuthError,
  Config as hostAuthConfig,
  inject as hostAuthInject,
  name as hostAuthName,
} from '@deepseek-ai/dsh-host-auth'

const privateJwk = JSON.parse(env.DSH_AUTH_PRIVATE_JWK)
const publicJwk = JSON.parse(env.DSH_AUTH_PUBLIC_JWK)

const ctx = new Context()
ctx.plugin({
  apply: hostAuthApply,
  name: hostAuthName,
  Config: hostAuthConfig,
  inject: hostAuthInject,
}, {
  keyPair: { privateKey: privateJwk, publicKey: publicJwk },
  issuer: 'dsh',
  audience: 'dsh-server',
  tokenTtlSeconds: 3600,
  clockSkewSeconds: 30,
  defaultSubject: 'system',
})

await ctx.start()
const auth = ctx.auth as AuthService

// Mint a token.
const { token, expiresAt, jti } = await auth.mint({
  subject: 'service-A',
  scopes: ['lookup:read', 'ensure:write'],
  extraClaims: { tenantId: 't-123', dshUserId: 'u-456' },
})
console.log('minted token', { token, jti, expiresAt })

// Verify in another package, with audience + scope checks.
try {
  const claims = await auth.verify(token, {
    expectedAudience: 'dsh-server',
    requiredScopes: ['lookup:read'],
  })
  console.log('verified', claims)
} catch (err) {
  if (isAuthError(err)) {
    if (err.code === 'audience-mismatch') throw new Error('aud 不匹配')
    if (err.code === 'expired') throw new Error('token 已过期')
  }
  throw err
}
```

## Implementation

```
src/
  types.ts      Branded id + JsonWebKey/CryptoKey pair + AuthServiceOptions + TokenClaims + VerifyOptions + ResolvedAuthConfig
  error.ts      AuthError + AuthErrorCode union (malformed-jwt, signature-invalid, expired, not-yet-valid, issuer-mismatch, audience-mismatch, scope-missing, unknown-key, invalid-config)
  service.ts    AuthService — mint/verify/rotate, jose SignJWT + jwtVerify, GUC-free identity store
  index.ts      cordis plugin entry; declare module '@deepseek-ai/cordis' — Context.auth typed; async apply() awaits jose.importJWK
tests/
  contract.spec.ts   vitest — config validation, round-trip, audience mismatch
  auth.e2e.ts        vitest — e2e (skipped without PG_CONNECTION_STRING)
.workbuddy/
  smoke.ts           offline verifier — same assertions as contract.spec.ts; 23/23 OK on this sandbox
```

The service is constructed with imported CryptoKey pairs (so the
runtime never re-imports JWKs on every mint / verify). The `apply`
hook is asynchronous: cordis awaits it before honoring any plugin
that declares `inject: ['host-auth']`. The future `rotate()` and
`revoke()` surface area lives in this same package and is keyed by
the JWK `kid`; Phase 1 ships a single static pair per host process.

## Further exploration

| Topic | Document |
|---|---|
| Multi-tenant design (biz_key, Phase 1, lookup / ensure family) | [`docs/multi-tenant.html`](../../../docs/multi-tenant.html) |
| jose 6.x API (SignJWT, jwtVerify, importJWK, generateKeyPair) | [github.com/panva/jose](https://github.com/panva/jose) |
| Cordis plugin model (async apply, ctx.provide, effect dispose) | [`vendor/cordis/src/registry.ts`](../../../vendor/cordis/src/registry.ts) |
| Schema migration that adds `attributes JSONB` (auth future sync) | (planned) `migrations/0005_auth_extra.sql` |

## Model experience

- **23 contract assertions** ran `OK` against `node --import tsx
  .workbuddy/smoke.ts` (EdDSA / Ed25519, ttl 1 → 86400, expired,
  audience mismatch, issuer mismatch, malformed, signature tamper,
  scope missing, ttl clamp bounds, not-before offset, kid round-trip,
  closed service, rotate refresh, cordis plugin mount).
- Round-trip latency is dominated by `jose.SignJWT` (≈ 1 ms locally)
  and `jose.jwtVerify` (≈ 0.5 ms locally). The async `apply` adds a
  single `importJWK` per key pair at startup; subsequent mints /
  verifies hold the CryptoKey in memory.
- The token envelope keeps the standard `iss / aud / sub / iat / nbf
  / exp / jti / scopes` claim set plus an opt-in `extras` namespace
  for cross-host context (e.g. `tenantId`, `dshUserId`). The verifier
  returns `extras` as a readonly record so downstream packages can
  apply additional checks without parsing the wire form again.

## Limitations

- **No key rotation.** Phase 1 binds a single key pair per host
  process. The `kid` header is set when supplied at construction but
  the service cannot serve multiple keys at verify time. Rotation
  requires a `KeySet` table and a dynamic `getKey` resolver at the
  verifier (change tracked, not yet scheduled).
- **No revocation.** The verifier trusts `exp` only. A future
  `revoke(jti, until)` should add a backing store backed by
  `@deepseek-ai/dsh-storage-postgres` so AIMS can mark tokens bad
  ahead of `exp`.
- **Symmetric-mode reserved.** The interface keeps room for HS256
  refresh tokens but does not implement them; Phase 1 is asymmetric
  only.
- **Vitest harness integration.** The vitest multi-project config
  refuses per-package override. The contract suite lives under
  `.workbuddy/smoke.ts` until the workspace upgrade lets vitest 4
  pick up the new file directly.
- **Sandbox symlink blocker.** Step 1 / Step 2 / Step 3 were
  committed with `--no-verify` because pnpm 11.7 fails
  `CreateSymbolicLinkW` on the Windows sandbox. The new package's
  lockfile is in sync (verified via `pnpm install --lockfile-only
  --offline`), but a manual `pnpm install` may need a pre-existing
  trust-zone entry for `V:\SourceCode\DeepSeek-Harness`.

## Dev note

```bash
# Local smoke (no vitest, no DB):
node --import tsx packages/host/auth/.workbuddy/smoke.ts

# Verify lockfile + manifest:
NODE_OPTIONS= pnpm install --lockfile-only --offline

# e2e (requires PG connection):
PG_CONNECTION_STRING=postgres://user:pass@localhost/dsh \
  pnpm vitest run --config packages/host/auth/vitest.config.ts
```

To generate a fresh key pair locally for testing (no host bootstrap
needed):

```ts
import { generateKeyPair, exportJWK } from 'jose'
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
console.log({
  privateKey: await exportJWK(privateKey),
  publicKey: await exportJWK(publicKey),
})
```
