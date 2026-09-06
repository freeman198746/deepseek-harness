---
description: "面向多租户存储后端的、带 Row-Level Security 的 PostgreSQL 行存储。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-postgres

[English](README.md) | 中文

## 概述

`dsh-storage-postgres` 是多租户方案选定的行存储后端：一个 PostgreSQL 数据库承载 `app_user`、`workspace`、`session_meta` 等表，每张表启用 Row-Level Security，让一次会话只能读到其租户+用户所拥有的行；激活时迁移跑批自动建表。它**不是**存储 hub 的后端——hub 仅支持 KV，不支持 JOIN、外键与 RLS；因此本包以 `ctx.pgstore` 形式挂载，消费方直接调用 `ctx.pgstore.client.withTenant(...)`。本包只面向宿主侧，不贡献提示词、工具或 schema，模型与 agent loop 都看不到它。

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

当组合需要多租户行存储——工作空间、会话行、成员、共享、审计日志及配套簿记——使用本包。本包持有连接池，激活时跑批内置迁移。

### 何时选择

部署运行在 Phase 1（单进程多租户）且需要 JOIN 关系行的场景——作为存储 hub 的补集，承载工作空间、会话、成员与审计。若部署是单租户且存储 hub 的 KV 后端已覆盖所有需求，则不必引入本包——连接池与迁移流水线的成本只为多租户数据买单。

### 配置

```yaml
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: postgres://emr_user@db:5432/shcis_uaiagent?searchpath=dbo
    autoMigrate: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `connectionString` | 必填 | `pg.PoolConfig.connectionString`。连接的账号**不能**是 PostgreSQL superuser——superuser 会绕过 RLS，本包的 fail-closed 保障依赖所有连接都运行在行存储的角色下。 |
| `schema` | `dbo` | 包装器在每个租户事务内通过 `SET LOCAL` 固定的 Postgres `search_path`。 |
| `maxPoolSize` | `pg` 默认（10） | 最大连接池大小。 |
| `idleTimeoutMs` | `pg` 默认 | 空闲连接超时（毫秒）。 |
| `connectionTimeoutMs` | `pg` 默认 | 建连超时（毫秒）。 |
| `autoMigrate` | `true` | 激活时跑批内置迁移。若外部流水线（`psql -f`、`flyway` 等）管理 schema，请设为 `false`。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-storage-postgres)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可观察行为

每次 `ctx.pgstore.client.withTenant(context, fn)` 会获取连接、执行 `BEGIN`、通过 `SELECT set_config(name, value, is_local := true)` 设置 `dsh.tenant` / `dsh.uid` / `dsh.trace_id`、固定 `SET LOCAL search_path TO <schema>`、执行包装体、提交。包装体或提交失败时先 `ROLLBACK` 再释放连接；GUC 在提交时消失，绝不泄漏到下一事务。

若忘记调用 `withTenant` 却访问带 RLS 的表，立即报错：`dsh.tenant` 未设置，SECURITY DEFINER 辅助函数 `dsh_current_tenant()` 抛异常，查询触不到表。迁移走独立的 `withConnection` 路径，便于在租户 GUC 进入作用域前先创建 `schema_migrations`。

迁移文件名已记录在 `schema_migrations`，但正文 checksum 发生变化时，触发 `migration-failed`——漂移被视作部署错误，绝不静默重放。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包把存储 hub 通常混在一起的三件事拆开。

### 设计理念

- **`withTenant` 是访问带租户表的唯一入口。** GUC 固定、`search_path`、事务边界在此交汇。其他原语——`withConnection`、`query`——只用于管理与引导。
- **RLS 做多租户过滤，而不是应用层。** 应用从不写 `WHERE tenant_id = ...`。Schema 声明策略，SECURITY DEFINER 辅助函数 `dsh_current_tenant()` / `dsh_current_uid()` 读 GUC，`audit_log` 上的触发器拒绝 `tenant_id` 与 GUC 不一致的行——对绕过 RLS 写入策略的跨租户 INSERT 多一道兜底。
- **迁移幂等且带 checksum。** `schema_migrations` 记录 `(file, checksum, applied_at)`。若记录的 checksum 仍与正文一致则跳过；若文件名已记录但 checksum 不一致则 `migration-failed`——作者必须增加数字前缀并新建文件。
- **连接池由 effect 关闭。** 插件 `apply()` 注册 `ctx.pgstore`，再挂一个 effect，其 disposer 调用 `client.close()`。插件自身不在 cordis 卸载前持有连接池，由 effect 托管，因此外部处置的上下文也能干净地排空连接池。

### 连接池生命周期

`activate()` 幂等：并发或重复调用解析为同一份 `MigrationResult`。`close()` 等待任意进行中的激活完成后调用 `pg.Pool.end()`。关闭后的获取抛 `pool-closed`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name` / `inject` / `Config` / `apply`，挂载 `ctx.pgstore`，安排迁移与连接池关闭 |
| [`src/service.ts`](src/service.ts) | `PgStoreService`：幂等 `activate()`、`close()`，schema/默认解析 |
| [`src/client.ts`](src/client.ts) | `PgClient`：连接池所有者，`withTenant` / `withConnection` / `query`，`SET LOCAL search_path` |
| [`src/migrate.ts`](src/migrate.ts) | `loadMigrations`、`migrationChecksum`、`applyMigrations`（幂等 + 漂移守卫） |
| [`src/error.ts`](src/error.ts) | `DshPostgresError` 与稳定的错误码 |
| [`src/types.ts`](src/types.ts) | 带品牌的 id（`TenantId`、`UserId`、`WorkspaceId`、`SessionId`）、`TenantContext`、`Migration`、`MigrationResult` |
| [`migrations/0001_initial.sql`](migrations/0001_initial.sql) | 11 张表 + 索引 + 租户触发器 |
| [`migrations/0002_rls.sql`](migrations/0002_rls.sql) | RLS 策略 + SECURITY DEFINER 辅助函数 |
| [`migrations/0003_biz_key.sql`](migrations/0003_biz_key.sql) | `biz_key` + `UNIQUE (tenant_id, biz_key)` + `status` / `privacy` 字段 |
| [`migrations/0010_test_data.sql`](migrations/0010_test_data.sql) | 1 tenant / 3 users / 3 workspaces / 5 sessions 测试数据集 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本后端视角不够用时阅读以下页面：存储子系统参考是权威约定，多租户方案是设计真源。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——hub 约定、领域语义与 KV 后端家族。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [多租户方案](../../../docs/multi-tenant.html)——设计依据、`biz_key` 三前缀约定与 Phase 1 边界。
- [AIMS-DSH 集成方案](../../../docs/AIMS-DSH多租户对接方案.html)——跨系统约定方案与 Phase 1 mock 桩先行路径。

-----

<a id="model-experience"></a>
## 模型体验

### 已存记录

#### 模型看到什么

无。本包不贡献提示词、工具或 schema；它在 `ctx.pgstore` 后面持久化多租户领域数据，只供宿主侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：本包从不触碰实时请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **Phase 1 单进程**——多租户方案以单个 Node 进程为部署单位；多进程部署需要本包未提供的协调层。
- **RLS 依赖连接角色**——运维方必须以非 superuser 账号（`emr_user` 风格）连接，否则每行都通过策略检查。`set_config` 的 GUC 固定也会被绕过，因此 superuser 客户端会静默读到所有数据。
- **每次激活默认都跑迁移**——外部迁移流水线必须设置 `autoMigrate: false`，或接受「先应用再跳过」的行为。`PgStoreService.activate()` 内部把并发激活串行化，但多个进程同时启动时底层 `pg.Pool` 会排队。
- **`schema_migrations` 漂移是硬错误**——已应用的迁移正文被编辑后会抛 `migration-failed`。解法是新建更高数字前缀的文件，绝不原地改写。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>