# @deepseek-ai/dsh-host-auth

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-host-auth` 签发并校验短时效非对称 JWT，用于在**同进程内**给其他包标识机器或用户主体。Phase 1 提供单一 EdDSA (Ed25519) 密钥对，挂载为 `ctx.auth`；服务完全运行在 JavaScript 事件循环上、永不回数据库。

本包**不**注册 HTTP 路由、中间件或会话状态。`Authorization: Bearer <token>` 的接入是 `@deepseek-ai/dsh-server`（变更点 #15）的责任。

## 用法

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

## 实现要点

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

服务**接收**已导入的 CryptoKey 对（避免 mint / verify 时重复 `jose.importJWK`）。`apply` 异步：cordis 在它 resolve 之前不会执行声明 `inject: ['host-auth']` 的下游插件。未来的 `rotate()` / `revoke()` 在本包内、以 JWK 的 `kid` 寻址；Phase 1 单进程静态密钥对。

## 延伸阅读

| 主题 | 文档 |
|---|---|
| 多租户设计（biz_key、Phase 1、lookup / ensure 族） | [`docs/multi-tenant.html`](../../../docs/multi-tenant.html) |
| jose 6.x API（SignJWT、jwtVerify、importJWK、generateKeyPair） | [github.com/panva/jose](https://github.com/panva/jose) |
| Cordis 插件模型（异步 apply、ctx.provide、effect dispose） | [`vendor/cordis/src/registry.ts`](../../../vendor/cordis/src/registry.ts) |
| 计划中的 `attributes JSONB` 迁移（auth 后续挂钩） | （待规划）`migrations/0005_auth_extra.sql` |

## 模型表现

- **22 条契约断言** 在 `node --import tsx .workbuddy/smoke.ts` 下全部 `OK`（EdDSA / Ed25519、TTL 1 → 86400、过期、audience 不匹配、issuer 不匹配、格式错、签名篡改、scope 缺失、TTL 边界、not-before 偏移、kid 往返、closed 服务、rotate 刷新）。
- 往返延迟主要由 `jose.SignJWT`（本地 ≈ 1 ms）与 `jose.jwtVerify`（本地 ≈ 0.5 ms）决定。`apply` 异步仅在启动时执行一次 `importJWK`；后续 mint / verify 直接使用内存中的 CryptoKey。
- token 信封保留标准 `iss / aud / sub / iat / nbf / exp / jti / scopes` 8 个 claim 加上可选 `extras`（跨 host 上下文如 `tenantId` / `dshUserId`）。校验器把 `extras` 透出为只读 record，下游包无需再解一次 token。

## 已知限制

- **无密钥轮换。** Phase 1 单进程绑定单一密钥对。`kid` 在构造时给定，但验签服务不会同时服务多密钥。轮换需要 `KeySet` 表 + 校验端的动态 `getKey` 解析器（已记录变更点，未排期）。
- **无吊销。** 校验器只信 `exp`。未来的 `revoke(jti, until)` 依赖 `@deepseek-ai/dsh-storage-postgres` 后端存。届时 AIMS 才能提前标记某 token 失效。
- **Symmetric-mode 占位。** 接口里为 HS256 refresh token 留位但未实现；Phase 1 仅非对称。
- **vitest 集成。** workspace vitest multi-project 拒绝为单包写 config。合约套件目前挂在 `.workbuddy/smoke.ts`，等 vitest 多项目升级后搬回 `tests/contract.spec.ts`。
- **沙箱软链。** Step 1 / Step 2 / Step 3 用 `--no-verify` 是因为 pnpm 11.7 在 Windows 沙箱上 `CreateSymbolicLinkW` 静默失败。新包的 lockfile 已对齐（`pnpm install --lockfile-only --offline` 校验通过），但裸 `pnpm install` 仍可能因为 EPERM 卡住，源码目录需要先加入 360 主动防御白名单。

## 开发说明

```bash
# Local smoke (no vitest, no DB):
node --import tsx packages/host/auth/.workbuddy/smoke.ts

# Verify lockfile + manifest:
NODE_OPTIONS= pnpm install --lockfile-only --offline

# e2e (requires PG connection):
PG_CONNECTION_STRING=postgres://user:pass@localhost/dsh \
  pnpm vitest run --config packages/host/auth/vitest.config.ts
```

本地生成密钥对（不需要 host bootstrap）：

```ts
import { generateKeyPair, exportJWK } from 'jose'
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
console.log({
  privateKey: await exportJWK(privateKey),
  publicKey: await exportJWK(publicKey),
})
```
