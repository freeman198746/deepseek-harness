-- ============================================================================
-- 0001_initial.sql — DSH 多用户改造 Phase 1 初始 DDL（v0.1 基线）
-- ============================================================================
-- 设计依据：《DeepSeek-Harness-多用户租户改造方案.html》§十四 14.1
-- 改动点：#4 storage-postgres（新插件包）；表命名按方案 §十三 图（去 mu_ 前缀）
-- 11 张表：tenant / app_user / workspace / workspace_member / session_meta /
--          session_share / memory / artifact / plugin / plugin_policy / audit_log
--
-- 注意：
--   1. 本脚本由 superuser（postgres）执行，建表 + 授权给 emr_user
--   2. 默认权限：postgres 在 dbo 上后续建的表自动授权给 emr_user（pg_init.py 已配）
--   3. RLS 在 0002 单独开启；本脚本只建结构，不开策略
--   4. 业务键（biz_key）+ 状态字段在 0003 增量加入（对应方案改动点 #18）
-- ============================================================================

SET search_path = dbo, public;

-- ============ 1. 租户与用户 ============

CREATE TABLE tenant (
  tenant_id   UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  quota_bytes BIGINT NOT NULL DEFAULT 10737418240,  -- 10 GiB 默认配额（方案 §三 P1/P2 配额管理）
  encrypt_key BYTEA,                                -- 租户级加密密钥（Phase 1 暂不写入，列预留）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  user_id    UUID PRIMARY KEY,                       -- 本地模式固定 '00000000-0000-0000-0000-00000000000d'
  tenant_id  UUID NOT NULL REFERENCES tenant(tenant_id) ON DELETE RESTRICT,
  username   TEXT NOT NULL,
  auth_type  TEXT NOT NULL CHECK (auth_type IN ('token','oidc','apikey','local')),
  auth_ref   TEXT,                                   -- oidc subject / token hash / apikey id
  credential BYTEA,                                  -- 加密的 API 凭证（Phase 1 暂不写入，列预留）
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','sysadmin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE INDEX idx_app_user_auth_ref ON app_user (auth_type, auth_ref);

-- ============ 2. 工作区归属 ============

CREATE TABLE workspace (
  workspace_id  UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  tenant_id     UUID NOT NULL REFERENCES tenant(tenant_id) ON DELETE RESTRICT,
  display_name  TEXT NOT NULL,
  dir_path      TEXT NOT NULL,                       -- 桶内相对路径；R1 路径逃逸防御点
  is_shared     BOOLEAN NOT NULL DEFAULT false,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_owner ON workspace (owner_user_id);
CREATE INDEX idx_workspace_tenant_shared ON workspace (tenant_id, is_shared);

CREATE TABLE workspace_member (                      -- 共享工作区成员表（M:N）
  workspace_id UUID NOT NULL REFERENCES workspace(workspace_id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('reader','writer')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_member_user ON workspace_member (user_id);

-- ============ 3. 会话归属（jsonl 正文在文件桶；本表 = PG 索引层）============

CREATE TABLE session_meta (
  session_id   TEXT PRIMARY KEY,                     -- 现有 session uuid 字符串（兼容 dsh 历史）
  user_id      UUID NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  workspace_id UUID REFERENCES workspace(workspace_id) ON DELETE SET NULL,  -- 删工作区后保留会话
  tenant_id    UUID NOT NULL,                        -- 冗余列；RLS 行过滤专用（无 FK，按方案 §十三）
  title        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_meta_user ON session_meta (user_id, updated_at DESC);
CREATE INDEX idx_session_meta_workspace ON session_meta (workspace_id);
CREATE INDEX idx_session_meta_title_fts ON session_meta
  USING gin (to_tsvector('simple', coalesce(title,'')));

-- ============ 4. 会话共享（一次性/永久/链接）============

CREATE TABLE session_share (
  share_id     UUID PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES session_meta(session_id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','tenant','link')),
  grantee_id   TEXT,                                 -- user_id / tenant_id / 一次性 token
  permission   TEXT NOT NULL CHECK (permission IN ('read','fork')),
  expires_at   TIMESTAMPTZ,
  created_by   UUID NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_share_session ON session_share (session_id);
CREATE INDEX idx_session_share_grantee ON session_share (grantee_type, grantee_id);

-- ============ 5. 记忆（L3/L4）============

CREATE TABLE memory (
  memory_id      UUID PRIMARY KEY,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('user','tenant')),
  scope_id       UUID NOT NULL,                      -- 多态：app_user.user_id / tenant.tenant_id（应用层校验）
  content        TEXT NOT NULL,
  source_session TEXT REFERENCES session_meta(session_id) ON DELETE SET NULL,
  weight         INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_memory_scope ON memory (scope_type, scope_id, updated_at DESC);

-- ============ 6. 资产登记（附件/导出物）============

CREATE TABLE artifact (
  artifact_id UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL,                         -- 冗余列；RLS 过滤专用
  user_id     UUID NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  session_id  TEXT REFERENCES session_meta(session_id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('attachment','export','spill')),
  name        TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_uri TEXT NOT NULL,                         -- 桶内 URI（users/<uid>/attachments/...）
  mime_type   TEXT,
  expires_at  TIMESTAMPTZ,                          -- P2 配额定期清理的钩子
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_artifact_user ON artifact (user_id, created_at DESC);
CREATE INDEX idx_artifact_session ON artifact (session_id);
CREATE INDEX idx_artifact_expires ON artifact (expires_at) WHERE expires_at IS NOT NULL;

-- ============ 7. 插件登记（系统级 / 租户级 / 用户级三级）============

CREATE TABLE plugin (
  plugin_id    TEXT PRIMARY KEY,                     -- plugin package name（如 @deepseek-ai/dsh-storage-postgres）
  version      TEXT NOT NULL,
  tenant_id    UUID REFERENCES tenant(tenant_id) ON DELETE CASCADE,  -- 可空=system 级
  user_id      UUID REFERENCES app_user(user_id) ON DELETE CASCADE,  -- 可空=system/tenant 级
  scope        TEXT NOT NULL CHECK (scope IN ('system','tenant','user')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_plugin_scope_tenant ON plugin (scope, tenant_id);

CREATE TABLE plugin_policy (
  policy_id  UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  plugin_id  TEXT NOT NULL REFERENCES plugin(plugin_id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('allow','force','lock')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plugin_id, permission)
);

-- ============ 8. 审计日志（v2026-09-06 第二轮补全）============

CREATE TABLE audit_log (
  audit_id      BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenant(tenant_id),
  actor_user_id UUID REFERENCES app_user(user_id),                   -- 可空=机器身份；机器身份下用 apimachine 虚拟用户
  session_id    TEXT REFERENCES session_meta(session_id),            -- 可空（机器渠道）
  trace_id      UUID NOT NULL,                                        -- X-Dsh-Trace-Id 透传
  action        TEXT NOT NULL,                                        -- e.g. workspaces.ensure / token.issue / lookup.user
  target_type   TEXT,                                                 -- e.g. workspace / session / credential
  target_id     TEXT,                                                 -- 目标 id（uuid 或 biz_key 字符串）
  payload       JSONB,                                                -- 请求/响应摘要（脱敏）
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_log_trace ON audit_log (trace_id);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_user_id, occurred_at DESC);
COMMENT ON COLUMN audit_log.actor_user_id IS '机器渠道下为虚拟系统用户 uid=apimachine；action 前缀 machine.* 区分';

-- audit_log 自动从 GUC 取 trace_id（如调用方未指定）
CREATE OR REPLACE FUNCTION audit_log_default_trace_id() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.trace_id IS NULL THEN
    NEW.trace_id := dsh_current_trace_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_trace_default BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_default_trace_id();

-- ============ updated_at 自动触发器 ==========

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenant_updated_at BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_workspace_updated_at BEFORE UPDATE ON workspace
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_session_meta_updated_at BEFORE UPDATE ON session_meta
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_memory_updated_at BEFORE UPDATE ON memory
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============ schema 元数据 ==========

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);