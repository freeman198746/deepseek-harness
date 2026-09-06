-- ============================================================================
-- 0003_biz_key.sql — v0.2 增量 DDL：宿主业务键 + 状态机字段
-- ============================================================================
-- 对应方案改动点：#18 migrations/0003_biz_key.sql
-- 影响范围：app_user / workspace / session_meta 三张表
-- 业务键三前缀命名空间约定（决策点 ⑥ v0.4 已拍板）：
--   aims.{userCode}            — 用户主工作空间/身份
--   patient.{cureno}           — 患者工作空间
--   visit.{visitId}            — 单次就诊会话
-- DSH 不解析语义，仅做唯一性兜底 + 反查族支撑（host/lookup）
-- ============================================================================

SET search_path = dbo, public;

-- ============ 1. app_user 加 biz_key ============

ALTER TABLE app_user
  ADD COLUMN biz_key TEXT;

-- 已存在的 username UNIQUE 保留；biz_key 在同租户内必须唯一（与 username 二选一作 ensure 幂等键）
-- 注：biz_key 可空（本地 CLI 用户无宿主业务键），所以用 UNIQUE NULLS DISTINCT（PG 15+ 默认）
ALTER TABLE app_user
  ADD CONSTRAINT uq_app_user_tenant_biz_key UNIQUE (tenant_id, biz_key);

CREATE INDEX idx_app_user_biz ON app_user (tenant_id, biz_key)
  WHERE biz_key IS NOT NULL;

-- ============ 2. workspace 加 biz_key + status + privacy ============

ALTER TABLE workspace
  ADD COLUMN biz_key TEXT;

ALTER TABLE workspace
  ADD CONSTRAINT uq_workspace_tenant_biz_key UNIQUE (tenant_id, biz_key);

CREATE INDEX idx_workspace_biz ON workspace (tenant_id, biz_key)
  WHERE biz_key IS NOT NULL;

ALTER TABLE workspace
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived'));

ALTER TABLE workspace
  ADD COLUMN privacy TEXT NOT NULL DEFAULT 'shared'
    CHECK (privacy IN ('shared','private'));

CREATE INDEX idx_workspace_status ON workspace (tenant_id, status);
CREATE INDEX idx_workspace_privacy ON workspace (tenant_id, privacy);

-- ============ 3. session_meta 加 biz_key + status ============

ALTER TABLE session_meta
  ADD COLUMN biz_key TEXT;

ALTER TABLE session_meta
  ADD CONSTRAINT uq_session_meta_tenant_biz_key UNIQUE (tenant_id, biz_key);

CREATE INDEX idx_session_meta_biz ON session_meta (tenant_id, biz_key)
  WHERE biz_key IS NOT NULL;

ALTER TABLE session_meta
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','closed'));

CREATE INDEX idx_session_meta_status ON session_meta (tenant_id, status);

-- ============ 4. 数据迁移（如 0001 已有数据，填充默认值）============
-- 本次 Phase 1 起步为空库；保留此段供未来生产升级使用

UPDATE workspace SET status = 'active' WHERE status IS NULL;
UPDATE workspace SET privacy = 'shared' WHERE privacy IS NULL;
UPDATE session_meta SET status = 'active' WHERE status IS NULL;