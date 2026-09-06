-- ============================================================================
-- 0002_rls.sql — 行级安全策略（DSH 多用户改造 Phase 1 R2/R7 兜底）
-- ============================================================================
-- 设计依据：方案 §十七 R2（FTS 越权）+ R7（RLS 被绕过）+ §三 连接级 SET LOCAL
-- 关键约束：
--   1. RLS 对表 owner / superuser 默认 BYPASSRLS=true 不生效
--   2. 服务账号 emr_user 必须为非 owner 普通角色（已确认：bypassrls=false）
--   3. 每请求 BEGIN + SET LOCAL dsh.tenant + SET LOCAL dsh.uid，事务结束即失效
--   4. 不开 RLS 的表 = 不受应用层隔离保护（仅 audit_log 保留 insert-only 开放）
-- ============================================================================

SET search_path = dbo, public;

-- ============ 辅助函数：从 GUC 读当前上下文 ============
-- dsh.tenant:  当前请求的租户 id（UUID 文本）
-- dsh.uid:     当前请求的用户 id（UUID 文本；机器渠道下为 apimachine 系统用户 UUID）
-- dsh.trace_id: 当前请求的 trace id（UUID 文本，审计写入用）

CREATE OR REPLACE FUNCTION dsh_current_tenant() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('dsh.tenant', true);
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'dsh.tenant GUC 未设置（每请求必须 SET LOCAL dsh.tenant = <uuid>）';
  END IF;
  RETURN v::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION dsh_current_uid() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('dsh.uid', true);
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'dsh.uid GUC 未设置（每请求必须 SET LOCAL dsh.uid = <uuid>）';
  END IF;
  RETURN v::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION dsh_current_trace_id() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('dsh.trace_id', true);
  IF v IS NULL OR v = '' THEN
    RETURN gen_random_uuid();  -- 兜底；正常路径必须由调用方显式传入
  END IF;
  RETURN v::uuid;
END;
$$;

-- ============ SECURITY DEFINER 辅助函数（绕过 RLS 做跨表判断）============
-- workspace 和 workspace_member 互查会触发无限循环；用 SECURITY DEFINER 函数
-- 以函数 owner（postgres superuser）权限运行，绕过 RLS 但仍受 GUC 控制

CREATE OR REPLACE FUNCTION dsh_user_can_see_workspace(p_workspace_id UUID) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  -- owner 直接可见；成员通过 workspace_member 可见
  SELECT EXISTS (
    SELECT 1 FROM workspace w
    WHERE w.workspace_id = p_workspace_id
      AND w.tenant_id = dsh_current_tenant()
      AND w.owner_user_id = dsh_current_uid()
  ) OR EXISTS (
    SELECT 1 FROM workspace_member wm
    WHERE wm.workspace_id = p_workspace_id
      AND wm.user_id = dsh_current_uid()
  );
$$;
REVOKE EXECUTE ON FUNCTION dsh_user_can_see_workspace FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsh_user_can_see_workspace TO emr_user;

CREATE OR REPLACE FUNCTION dsh_user_workspaces() RETURNS TABLE(workspace_id UUID)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  -- 当前用户可见的所有 workspace（owner ∪ member）
  SELECT workspace_id FROM workspace
    WHERE tenant_id = dsh_current_tenant()
      AND owner_user_id = dsh_current_uid()
  UNION
  SELECT wm.workspace_id FROM workspace_member wm
    WHERE wm.user_id = dsh_current_uid();
$$;
REVOKE EXECUTE ON FUNCTION dsh_user_workspaces FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsh_user_workspaces TO emr_user;

CREATE OR REPLACE FUNCTION dsh_user_can_see_session(p_session_id TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  -- 自己 / 共享工作区内的 / 显式 share（未过期）
  SELECT EXISTS (
    SELECT 1 FROM session_meta s
    WHERE s.session_id = p_session_id
      AND s.tenant_id = dsh_current_tenant()
      AND (
        s.user_id = dsh_current_uid()
        OR s.workspace_id IN (SELECT workspace_id FROM dsh_user_workspaces())
        OR EXISTS (
          SELECT 1 FROM session_share ss
          WHERE ss.session_id = p_session_id
            AND ss.grantee_type = 'user'
            AND ss.grantee_id = dsh_current_uid()::text
            AND (ss.expires_at IS NULL OR ss.expires_at > now())
        )
      )
  );
$$;
REVOKE EXECUTE ON FUNCTION dsh_user_can_see_session FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsh_user_can_see_session TO emr_user;

-- ============ 1. tenant 表：管理员可读自己租户；非跨租户 ============

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_tenant_isolation ON tenant
  USING (tenant_id = dsh_current_tenant());

-- ============ 2. app_user 表：同租户可见；越租户拒 ============

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_app_user_tenant_isolation ON app_user
  USING (tenant_id = dsh_current_tenant());

-- ============ 3. workspace 表：owner + workspace_member 联合可见集 ============

ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workspace_visibility ON workspace
  USING (
    tenant_id = dsh_current_tenant()
    AND dsh_user_can_see_workspace(workspace_id)
  );

-- ============ 4. workspace_member 表：成员关系双向可见 ============

ALTER TABLE workspace_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workspace_member_visibility ON workspace_member
  USING (dsh_user_can_see_workspace(workspace_id));

-- ============ 5. session_meta 表：自己的 + 共享工作区内的 + 显式 share ============

ALTER TABLE session_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_session_meta_visibility ON session_meta
  USING (
    tenant_id = dsh_current_tenant()
    AND dsh_user_can_see_session(session_id)
  );

-- ============ 6. session_share 表：自己发起的 + 收到的 + 同 workspace 成员可见 ============

ALTER TABLE session_share ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_session_share_visibility ON session_share
  USING (
    created_by = dsh_current_uid()                                     -- 我发起的
    OR (grantee_type = 'user' AND grantee_id = dsh_current_uid()::text)  -- 我收到的
    OR EXISTS (
      SELECT 1 FROM session_meta s
      WHERE s.session_id = session_share.session_id
        AND s.workspace_id IN (SELECT workspace_id FROM dsh_user_workspaces())
    )
  );

-- ============ 7. memory 表：scope=user 自己；scope=tenant 同租户 ============

ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_memory_visibility ON memory
  USING (
    (scope_type = 'user'  AND scope_id = dsh_current_uid())
    OR
    (scope_type = 'tenant' AND scope_id = dsh_current_tenant())
  );

-- ============ 8. artifact 表：自己上传的 ============

ALTER TABLE artifact ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_artifact_owner_only ON artifact
  USING (tenant_id = dsh_current_tenant() AND user_id = dsh_current_uid());

-- ============ 9. plugin 表：系统级全租户可见；租户级同租户可见；用户级仅自己可见 ============

ALTER TABLE plugin ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_visibility ON plugin
  USING (
    (scope = 'system')
    OR (scope = 'tenant' AND tenant_id = dsh_current_tenant())
    OR (scope = 'user' AND user_id = dsh_current_uid())
  );

-- ============ 10. plugin_policy 表：同租户可见 ============

ALTER TABLE plugin_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_plugin_policy_tenant_isolation ON plugin_policy
  USING (tenant_id = dsh_current_tenant());

-- ============ 11. audit_log 表：同租户仅管理员可读；insert 全开 ============
-- audit_log 不开 RLS 的 SELECT，让 superuser/审计后台可全量读取
-- 写入走应用层强制带 tenant_id（不依赖 RLS 的 WITH CHECK）

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_audit_log_tenant_read ON audit_log
  FOR SELECT USING (tenant_id = dsh_current_tenant());
CREATE POLICY p_audit_log_insert_open ON audit_log
  FOR INSERT WITH CHECK (true);
-- 不开 UPDATE/DELETE 策略 = 默认拒绝任何更新/删除（审计只增）

-- ============ INSERT 校验（额外防御：写入 tenant_id 必须与当前请求一致）============
-- 这里用 CHECK 约束 + BEFORE INSERT 触发器做应用层兜底，避免应用 bug 写串租户

CREATE OR REPLACE FUNCTION assert_tenant_match() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM dsh_current_tenant() THEN
    RAISE EXCEPTION 'audit_log.tenant_id (%) 与 dsh.tenant GUC (%) 不一致', NEW.tenant_id, dsh_current_tenant();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_tenant_guard BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_match();

CREATE TRIGGER trg_artifact_tenant_guard BEFORE INSERT ON artifact
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_match();

CREATE TRIGGER trg_plugin_policy_tenant_guard BEFORE INSERT ON plugin_policy
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_match();