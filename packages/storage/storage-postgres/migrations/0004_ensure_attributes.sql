-- ============================================================================
-- 0004_ensure_attributes.sql — v0.2 第二轮增量：attrs JSONB 列
-- ============================================================================
-- 对应方案改动点：#18-v2 ensure_attributes
-- 范围：app_user / workspace / session_meta 三表加 attrs JSONB 列
-- 背景：
--   0003_biz_key.sql 已经把 biz_key + 状态机字段加上，但 attrs JSONB 列
--   还没落地。LookupService.ensure 现在能传 attrs 但 service.ts 注释说
--   "reserved for the migration that will expose them"——本次把它落地。
-- 设计要点：
--   1. 默认 '{}'：单行 INSERT 不带 attrs 也能存
--   2. NOT NULL：避免 type 推断为 null，DSH 侧 always 有 dict
--   3. GIN 索引：宿主可按 JSONB key 查询（如 attrs @> '{"privacy":"private"}'）
--   4. CHECK：必须是 object（不能用 array / scalar / null）—— 防御应用 bug
-- ============================================================================

SET search_path = dbo, public;

-- ============ 1. 三表统一加 attrs JSONB ============

ALTER TABLE app_user
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attrs) = 'object');

ALTER TABLE workspace
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attrs) = 'object');

ALTER TABLE session_meta
  ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attrs) = 'object');

-- ============ 2. GIN 索引（让宿主能用 JSONB 查询）============

CREATE INDEX idx_app_user_attrs    ON app_user    USING gin (attrs jsonb_path_ops);
CREATE INDEX idx_workspace_attrs   ON workspace   USING gin (attrs jsonb_path_ops);
CREATE INDEX idx_session_meta_attrs ON session_meta USING gin (attrs jsonb_path_ops);

-- ============ 3. 默认值回填（防御已有数据）============

UPDATE app_user     SET attrs = '{}'::jsonb WHERE attrs IS NULL;
UPDATE workspace    SET attrs = '{}'::jsonb WHERE attrs IS NULL;
UPDATE session_meta SET attrs = '{}'::jsonb WHERE attrs IS NULL;
