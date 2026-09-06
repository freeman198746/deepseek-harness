---
description: "DSH 多用户改造控制面 HTTP 服务器：在 dsh-host-webserver 上挂载 /mu/v1/{lookup,ensure,auth/token:issue,health}，Bearer-token 机器渠道鉴权"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-server

[English](README.md) | 中文

## 摘要

`dsh-host-server` 是把四个兄弟插件拼成一个 HTTP 控制面的编排插件：负责把 `dsh-host-webserver`（传输层）、`dsh-host-lookup`（反查族）、`dsh-host-auth`（EdDSA JWT 签发）与 `dsh-storage-postgres`（多租户行存储）串起来。它唯一的职责是在 `webServer.register()` 上挂六条路由，并在除 `/health` 外的所有读写接口前置一道机器渠道共享 API Key 的中间件。业务逻辑全部在四个兄弟包内，本包不持有任何业务规则。

## 目录

- [使用本包](#use-this-package)
- [实现要点](#understand-the-implementation)
- [路由矩阵](#route-surface)
- [配置](#configuration)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

本插件需在四个兄弟包之后装载。`inject` 列表强制顺序：`webServer` → `pgstore` / `auth` / `lookup` → `host-server`。

### 最小装配

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 3200
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: postgres://emr:password@127.0.0.1:5432/deepharness
- name: '@deepseek-ai/dsh-host-auth'
  config:
    keyPair:
      privateKey: <Ed25519 JWK private>
      publicKey:  <Ed25519 JWK public>
    issuer: dsh
    audience: dsh-apiproxy
- name: '@deepseek-ai/dsh-host-lookup'
  config: {}
- name: '@deepseek-ai/dsh-host-server'
  config:
    apiKey: <machine-channel shared secret, min 16 chars>
```

`apply()` 完成后 `ctx.dshServer` 已挂载，`webServer.port` 监听六条 `/mu/v1/*` 路径。

<a id="understand-the-implementation"></a>

## 实现要点

<details><summary>实现内部——点击展开</summary>

### 设计理念

本包只做"接线"。每个 handler 都是 `(req, res) => …` 工厂，依赖由对应兄弟服务注入；`ServerService` 持有 dispose 链，cordis 拆解时按注册反序撤销路由。Bearer 中间件读取 `Authorization: Bearer <apiKey>`，用 `crypto.timingSafeEqual` 比对，`apiKey` 永远只从 `Config` 取、绝不从请求字段取。`/health` 故意无需鉴权（负载均衡器不能携带凭证），探测不泄露租户上下文。

### 文件结构

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 插件入口；`inject: ['webServer','pgstore','auth','lookup']` |
| [`src/service.ts`](src/service.ts) | `ServerService` 继承 cordis `Service`；构建六条路由 spec，注册并按反序释放 |
| [`src/types.ts`](src/types.ts) | `MuRoute` / `BearerOutcome` / `RequestTenantContext` |
| [`src/error.ts`](src/error.ts) | `ServerError` + `ServerErrorCode` → HTTP 状态映射 |
| [`src/http.ts`](src/http.ts) | `readJsonBody`（上限 16 KiB） / `writeJson` / `writeOk` / `writeError` |
| [`src/middleware.ts`](src/middleware.ts) | `checkBearer` / `assertBearer` / `AUTHORIZATION_HEADER` / `TENANT_HEADER` / `TRACE_HEADER` |
| [`src/handlers/health.ts`](src/handlers/health.ts) | `makeHealthHandler` —— 公开 `GET /mu/v1/health`，2 秒 pgstore 探测 |
| [`src/handlers/lookup.ts`](src/handlers/lookup.ts) | `makeLookupHandler` —— `GET /mu/v1/lookup`，Bearer + 租户头 |
| [`src/handlers/ensure.ts`](src/handlers/ensure.ts) | `makeEnsureHandler(type, deps)` —— `POST /mu/v1/ensure/{user,workspace,session}` |
| [`src/handlers/token.ts`](src/handlers/token.ts) | `makeTokenHandler` —— `POST /mu/v1/auth/token:issue`，签发 EdDSA JWT |

### Handler 组合

每个 handler 是纯工厂：取所需依赖（`LookupService` / `AuthService` / `PgStoreService` / `apiKey`），返回 `async (req, res) => …` 函数。服务器注册这个函数，handler 不持有共享状态。

### 错误形态

错误响应统一为 `{ ok: false, code, message }`：`code` ∈ `unauthenticated | forbidden | not-found | bad-request | conflict | upstream-unavailable | internal-error`；HTTP 层通过 `ServerError.statusFor` 把映射集中在一处。

</details>

<a id="route-surface"></a>

## 路由矩阵

| 方法   | 路径                              | 鉴权                                                          | 请求体 / 查询                                                                                    | 响应                                                                                       |
|--------|-----------------------------------|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `GET`  | `/mu/v1/health`                   | 无（公开）                                                    | —                                                                                                 | `{ ok: true, status, service: 'dsh-host-server', pgstore: 'reachable' }`                   |
| `GET`  | `/mu/v1/lookup`                   | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`              | `?type={user\|workspace\|session}&biz_key=…&tenant_key=…`                                         | `{ ok: true, hit: { … } }` 或 `{ ok: true, miss: true }`                                   |
| `POST` | `/mu/v1/ensure/user`              | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`              | `{ bizKey: 'aims.<userCode>', tenantId, attrs? }`                                                 | `{ ok: true, id, bizKey, tenantId, createdAt, updatedAt }`                                 |
| `POST` | `/mu/v1/ensure/workspace`         | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`              | `{ bizKey: 'patient.<cureno>', tenantId, attrs? }`                                                | 同上                                                                                       |
| `POST` | `/mu/v1/ensure/session`           | `Authorization: Bearer <apiKey>` + `X-Dsh-Tenant`              | `{ bizKey: 'visit.<visitId>', tenantId, attrs? }`                                                 | 同上                                                                                       |
| `POST` | `/mu/v1/auth/token:issue`         | `Authorization: Bearer <apiKey>`                              | `{ subject, scopes?, audience?, ttlSeconds? }`                                                   | `{ ok: true, token, jti, expiresAt, audience }`                                            |

`ensure` 请求中的 `tenantId` 必须与 `X-Dsh-Tenant` 一致，不一致返回 `400 bad-request`。调用方应始终设置该请求头；body 里的字段仅与 lookup 的查询字符串对称。

<a id="configuration"></a>

## 配置

```typescript
interface HostServerConfig {
  readonly apiKey: string   // ≥ 16 chars, constant-time compared to Authorization header
  readonly keyId?: string   // free-form observability label, NOT used for routing
}
```

插件绝不记录 `apiKey`。运维方应通过密钥管理服务注入；轮换 = 改 config + 重启。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与待办

- Bearer 中间件当前共用单一 secret；下版本将拆为 `(keyId, secret)` + 每 key scopes 表
- 路由表已声明 requiredScopes 但中间件未强制；下个 minor 把 scopes 并入 `checkBearer`
- 审计日志（`audit_log`）尚未由 handler 写入；schema 与触发器已就位，下次小版本发出 `(tenantId, actor=apimachine, action=lookup|ensure|token:issue, traceId)` 行
- `POST /mu/v1/workspaces/{id}/members`（成员授予）与 `POST /mu/v1/workspaces/{id}:archive`（归档）留到兄弟插件，本服务器只挂上述四条端点
