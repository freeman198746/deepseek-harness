---
description: "面向多租户行存储的宿主业务键反查与幂等 ensure 编排器；把 (tenant_id, biz_key) 映射到 UUID 主键。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-lookup

[English](README.md) | 中文

## 概述

`dsh-host-lookup` 是多租户方案选定的宿主侧业务键反查编排器。它接收宿主已使用的稳定业务键（`aims.{userCode}` / `patient.{cureno}` / `visit.{visitId}`），把它解析为所属租户内的 UUID；并提供幂等的 `ensure` 调用——命中时返回已有行，未命中时插入最小记录。本包以 `ctx.lookup` 形式挂载，**不**注册 HTTP 路由——`GET /mu/v1/lookup` 与 `POST /mu/v1/ensure/{type}` 的接入由 `@deepseek-ai/dsh-server` 承担。

本包依赖 `@deepseek-ai/dsh-storage-postgres` 提供的连接池与迁移引导。它不直接对多租户 schema 写 SQL；每一次读写都走 `ctx.pgstore.client.withTenant(...)`，让 `dsh.tenant` / `dsh.uid` / `dsh.trace_id` 三件套在事务内固定，行级安全（RLS）兜底过滤。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

宿主需要把稳定的业务键（自有用户表的 `userCode`、EMR 病历的 `cureno`、临床就诊的 `visitId`）映射到内部 UUID 时使用本包。Phase 1 部署——AIMS 与 DSH 对话——每次面板渲染都会触发此映射；范围内每张表上的 `UNIQUE (tenant_id, biz_key)` 索引把往返时间压在 O(1) 毫秒级。

### 何时选择

宿主身份需要落到 DSH 存储作外键或联表列时使用本包。当宿主已有自有 UUID（无 biz_key 介入）或关系一次性、手工 SQL `INSERT` 可接受时跳过本包。

### 配置

```yaml
- name: '@deepseek-ai/dsh-host-lookup'
  config:
    allowEnsureInsert: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowEnsureInsert` | `true` | 当 `true` 时 `ensure` 允许为未知 biz_key 插入记录。只读部署（缺失视为 bug）请设 `false`。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-lookup)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可观察行为

每次 `ctx.lookup.{user,workspace,session}(bizKey)` 调用会获取连接、执行 `BEGIN`、通过 `SELECT set_config(name, value, is_local := true)` 固定 `dsh.tenant` / `dsh.uid`、在范围内表上执行单行 SELECT、提交。`{ kind: 'miss' }` 是正常返回，不是错误。

`ctx.lookup.{user,workspace,session}.ensure({ tenantId, bizKey })` 执行 `INSERT ... ON CONFLICT (tenant_id, biz_key) DO NOTHING` 后再在相同谓词上 SELECT。第二条语句读回 INSERT 留下的记录（新行或既有行）。两条语句在同一个租户事务里执行，RLS 看到的状态一致。

若 `bizKey` 的前缀与请求类型不匹配（`aims.*` 仅供 `user`、`patient.*` 仅供 `workspace`、`visit.*` 仅供 `session`），调用在触碰数据库前抛 `LookupError`，`code: 'invalid-biz-key'`。强制前缀是因为存储 schema 用 `(tenant_id, biz_key)` 建索引——错的前缀要么撞其他命名空间的行、要么静默错过正确的那一行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是薄编排器，重活在 `@deepseek-ai/dsh-storage-postgres`。

### 设计理念

- **`withTenant` 是访问带保护表的唯一入口。** `dsh.tenant` / `dsh.uid` GUC 由 `pg.Pool` 包装器固定，`migrations/0002_rls.sql` 的 RLS 策略强制行过滤，`audit_log` 拒绝任何跨租户写入。反查族继承这三层保障。
- **三前缀约定在 API 边界强制，不在 SQL 层。** schema 只保留 `biz_key` 列与唯一性约束，前缀语义是宿主侧契约，本插件在下发 SQL 前校验。
- **`ensure` 是一条事务里的两条语句。** INSERT 与 SELECT 必须看到同一快照，未来 `attrs` 列落地时一次完成两件事的 CTE 难以维持正确。两段形式是有意为之。
- **不挂 HTTP 路由。** 把 `/mu/v1/lookup` 与 `/mu/v1/ensure/{type}` 的接入交给 `@deepseek-ai/dsh-server`，让本包保持无 HTTP、可被 CLI 工具、脚本、jest 套件等非 HTTP 上下文复用。

### 反查表映射

| 类型 | 表 | ID 列 | 保留前缀 |
|---|---|---|---|
| `user` | `app_user` | `user_id` | `aims` |
| `workspace` | `workspace` | `workspace_id` | `patient` |
| `session` | `session_meta` | `session_id` | `visit` |

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | cordis 插件入口：`name` / `inject` / `Config` / `apply`，挂载 `ctx.lookup` |
| [`src/service.ts`](src/service.ts) | `LookupService`：`lookup(type, bizKey, ctx)` 与 `ensure(request, ctx)` |
| [`src/biz-key.ts`](src/biz-key.ts) | `validateBizKey` + `extractBizKeyPrefix`，三前缀约定 |
| [`src/error.ts`](src/error.ts) | `LookupError` 与稳定的 `LookupErrorCode` 联合 |
| [`src/types.ts`](src/types.ts) | 带品牌的 id、`LookupType` / `BizKey` / `BizKeyPrefix`、`LookupOutcome` 判别联合 |
| [`tests/contract.spec.ts`](tests/contract.spec.ts) | vitest：前缀表、`validateBizKey` 接受/拒绝矩阵、`extractBizKeyPrefix` |
| [`tests/lookup.e2e.ts`](tests/lookup.e2e.ts) | vitest e2e：lookup miss、ensure 幂等、lookup hit——按 `PG_CONNECTION_STRING` 跳过 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本编排器视角不够用时阅读以下页面：存储子系统参考是权威约定，多租户方案是设计真源。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——hub 约定、领域语义与 KV 后端家族。
- [多租户方案](../../../docs/multi-tenant.html)——设计依据、`biz_key` 三前缀约定与 Phase 1 边界。
- [AIMS-DSH 集成方案](../../../docs/AIMS-DSH多租户对接方案.html)——跨系统约定方案与 Phase 1 mock 桩先行路径。

-----

<a id="model-experience"></a>
## 模型体验

### 已存记录

#### 模型看到什么

无。本包不贡献提示词、工具或 schema；它是宿主侧在需要把业务键翻成 UUID 时调用的内部编排器。模型从不直接调用 `ctx.lookup`。

#### Token 影响

实时请求 token 为零。`LookupService` 由宿主同步调用，不走 agent loop。

#### KV Cache 影响

无：反查族从不触碰实时请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本编排器何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **`attrs` 只是建议**——多租户 schema 在范围内表上不带自由格式的 JSONB 列。`ensure` 创建的记录只含 `tenant_id` + `biz_key`，任何 `attrs` 都会被忽略。迁移 `0004_ensure_attributes.sql`（计划中，未编写）会给 `app_user` / `workspace` / `session_meta` 加 `attributes JSONB` 列；届时本包开始写入该列。
- **Phase 1 单进程**——多租户方案以单个 Node 进程为部署单位；多进程部署需要本包未提供的协调层。
- **反查依赖 storage-postgres 先挂载**——若 `@deepseek-ai/dsh-host-lookup` 比 `@deepseek-ai/dsh-storage-postgres` 先装载，`ctx.pgstore` 是 `undefined`，`apply()` 在激活阶段抛错。`inject: ['pgstore']` 声明强制顺序，但构造自定义注册表的消费方仍需自查 `ctx.pgstore`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包是 AIMS 端 `DshLookupService` 在 Phase 1 mock 桩阶段调用的 API 表面。它产出的 HTTP 路由在 `@deepseek-ai/dsh-server` 里。`attrs` 跟进是下一个待规划与落地的迁移——把 `attributes JSONB` 列设为可空，让现有记录平滑过渡。

</details>