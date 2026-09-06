---
description: "`dsh-migrate-multiuser` 运维命令（#14）：把 @deepseek-ai/dsh-storage-postgres 的多租户 schema 应用到生产 PG 集群"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-cli-migrate

[English](README.md) | 中文

## 摘要

`dsh-migrate-multiuser` 是 `@deepseek-ai/dsh-storage-postgres` 的运维侧配套命令。负责把 `0001_initial.sql` / `0002_rls.sql` / `0003_biz_key.sql` / `0004_ensure_attributes.sql`——`tenant`、`app_user`、`workspace`、`workspace_member`、`session_meta`、`session_share`、`memory`、`artifact`、`plugin`、`plugin_policy`、`audit_log`、RLS 策略、`biz_key` 唯一索引、`status`/`privacy` CHECK 约束和 `attrs JSONB` 列——应用到生产 PG 集群。CLI 极简：读 `PG_CONNECTION_STRING`、构造一个 `PgStoreService`（`autoMigrate: false`）、调 `applyMigrations`、报告 applied/skipped。`--plan` 标志无需凭证即可列出迁移文件（dev / 预检场景）。

## 目录

- [使用本包](#use-this-package)
- [实现要点](#understand-the-implementation)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>

## 使用本包

### 用 `pnpm dlx` 跑（不安装）

```bash
pnpm dlx dsh-migrate-multiuser --plan
pnpm dlx dsh-migrate-multiuser --run
```

### 作为开发依赖安装

```bash
pnpm add -D @deepseek-ai/dsh-host-cli-migrate
```

安装后 `dsh-migrate-multiuser` 进入 PATH。两种调用方式都默认从环境变量读 `PG_CONNECTION_STRING`：

```bash
export PG_CONNECTION_STRING=postgres://emr:password@db.internal:5432/deepharness
export DSH_PG_SCHEMA=dbo          # optional; defaults to "dbo"

dsh-migrate-multiuser --run      # applies migrations in file order
dsh-migrate-multiuser --plan     # prints files, no DB touched
```

退出码沿用 `dsh` / `psql` 约定：

| 码 | 含义 |
|---|---|
| `0`  | 应用完成或已是最新 |
| `64` | 用法错误（未知 flag） |
| `65` | 缺少 `PG_CONNECTION_STRING` |
| `70` | schema 版本漂移（已记录文件被改） |
| `75` | 网络 / 连接失败 |
| `1`  | 未预期错误 |

### 从脚本里调库

```ts
import { runCli } from '@deepseek-ai/dsh-host-cli-migrate/src/cli.ts'

const code = await runCli(['--plan'], (s) => process.stdout.write(s), (s) => process.stderr.write(s))
process.exit(code)
```

<a id="understand-the-implementation"></a>

## 实现要点

<details><summary>实现内部——点击展开</summary>

### 设计理念

本 CLI 是"运维 shell ↔ applyMigrations"的胶水。自己解析 argv，不引 `commander`：6 个 flag 拉一个新依赖不划算；抽象出 `runCli(argv, stdout, stderr)` 让测试可以替换 stream。

### 文件结构

| 文件 | 角色 |
|---|---|
| [`src/cli.ts`](src/cli.ts) | `parseArgs` / `runCli` / `render` / `listMigrations` / `runMigrations` / `ExitCode` / `CliUsageError` / `printHelp` |
| [`bin/dsh-migrate-multiuser`](bin/dsh-migrate-multiuser) | shebang shim，转发 `index.ts` |
| [`index.ts`](index.ts) | 公共入口：`await runCli(process.argv.slice(2)); process.exit(code)` |

### 为什么 `autoMigrate: false`

`PgStoreService.activate()` 在 `autoMigrate: true` 时自动跑迁移（plugin 默认，便于热启动）。CLI 不希望这种"隐式副作用"——运维期望看到"applied N files"的可审计报告。所以传 `autoMigrate: false`、自己调 `applyMigrations`。

### 为什么独立成包

`dsh host-lookup` / `dsh host-server` 是长生命周期 cordis 进程；`dsh-migrate-multiuser` 是"一次性"运维命令。混进同一包会让运维拉一堆永远用不到的 `dsh-host-webserver` / `dsh-host-auth` / `dsh-host-lookup` 传递依赖。

</details>

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与待办

- DSH 计划 §14 的 `--to-postgres`（"本地 JSONL 升级为多用户 PG"）未实现：阶段 1 只交付 `dsh migrate multiuser --run`，从本地 CLI 升级是另一个独立运维流
- `--dry-run` / SQL 预览：当前 `--plan` 只列文件名，不打 SQL。先用 `--plan` + `cat migrations/<file>` 满足；use case 再次出现时加 `--sql` flag

<a id="dev-note"></a>

## Dev note

`bin/dsh-migrate-multiuser` 的 shebang 不打包 `tsx`——假设宿主机有 `tsx` 在 PATH 上。后续 `--bundle` 步骤会发射自包含 `.js` shim（含 `tsx` 内嵌）。
