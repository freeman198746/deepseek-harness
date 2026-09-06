-- ============================================================================
-- 0010_test_data.sql — DSH 测试数据集（§十四 14.1 PG 版）
-- ============================================================================
-- 测试租户：hospital_alpha（虚拟医院，1 院区）
-- 测试用户：alice（医生，主工作空间 owner）/ bob（医生，与 alice 同租户）
-- 测试工作区：3 个（alice 私有 1 + alice 共享 1 + bob 私有 1）
-- 测试会话：5 个（含 1 条 fork 血缘 + 1 条跨工作区）
-- 测试共享：2 条（read / fork 各一）
-- 测试记忆：L3（user 域 2 条）+ L4（tenant 域 2 条）
-- 测试资产：1 个附件 + 1 个导出物
--
-- 适用 RLS 验证：跨租户读 0 行 / 跨用户读 0 行 / 过期 share 读 0 行
-- ============================================================================

SET search_path = dbo, public;

-- ============ 1. 租户 ============

INSERT INTO tenant (tenant_id, name, quota_bytes) VALUES
  ('11111111-1111-1111-1111-111111111111', 'hospital_alpha', 10737418240);

-- ============ 2. 用户（alice 主 / bob）============

INSERT INTO app_user (user_id, tenant_id, username, auth_type, auth_ref, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'alice', 'oidc', 'oidc-alice-sub-001', 'user'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'bob',   'oidc', 'oidc-bob-sub-002',   'user'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'apimachine', 'apikey', 'sysmachine-001', 'sysadmin');

-- ============ 3. 工作区（3 个）============

INSERT INTO workspace (workspace_id, owner_user_id, tenant_id, display_name, dir_path, is_shared, biz_key, privacy) VALUES
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111',
   'alice 主工作空间', 'users/alice/main', false,
   'aims.alice-main', 'private'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111',
   '患者张三 · CURE001', 'users/alice/patients/CURE001', true,
   'patient.CURE001', 'shared'),
  ('44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111',
   'bob 主工作空间', 'users/bob/main', false,
   'aims.bob-main', 'private');

-- ============ 4. workspace_member（alice 张三工作区共享给 bob）============

INSERT INTO workspace_member (workspace_id, user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'reader');

-- ============ 5. 会话（5 个）============

INSERT INTO session_meta (session_id, user_id, workspace_id, tenant_id, title, biz_key, status) VALUES
  ('sess-001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111',
   '主工作台首轮对话', 'aims.alice-main/sess-001', 'active'),
  ('sess-002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
   '11111111-1111-1111-1111-111111111111',
   '张三 · 主诉分析', 'visit.V20260906001', 'active'),
  ('sess-003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
   '11111111-1111-1111-1111-111111111111',
   '张三 · 鉴别诊断（fork 自 sess-002）', 'visit.V20260906002', 'active'),
  ('sess-004', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444',
   '11111111-1111-1111-1111-111111111111',
   'bob 工作台', 'aims.bob-main/sess-001', 'active'),
  ('sess-005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111',
   '已结算会话示例', 'visit.V20260905099', 'closed');

-- ============ 6. session_share（2 条：read / fork）============

INSERT INTO session_share (share_id, session_id, grantee_type, grantee_id, permission, created_by) VALUES
  ('55555555-5555-5555-5555-555555555551', 'sess-002', 'user', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'read', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('55555555-5555-5555-5555-555555555552', 'sess-002', 'link', 'link-token-abc123', 'fork', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- 过期 share（用于 R7 负向用例：过期 share 读 0 行）
INSERT INTO session_share (share_id, session_id, grantee_type, grantee_id, permission, expires_at, created_by) VALUES
  ('55555555-5555-5555-5555-555555555553', 'sess-002', 'user', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'read', now() - interval '1 day', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- ============ 7. memory（L3/L4 各 2 条）============

INSERT INTO memory (memory_id, scope_type, scope_id, content, source_session, weight) VALUES
  ('66666666-6666-6666-6666-666666666661', 'user',   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice 偏好使用简明中文回答', 'sess-001', 5),
  ('66666666-6666-6666-6666-666666666662', 'user',   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice 常询问鉴别诊断', 'sess-003', 3),
  ('66666666-6666-6666-6666-666666666663', 'tenant', '11111111-1111-1111-1111-111111111111', '本科室常用药清单：XXX', NULL, 8),
  ('66666666-6666-6666-6666-666666666664', 'tenant', '11111111-1111-1111-1111-111111111111', '本院 SOP：会诊 48h 内完成', NULL, 7);

-- ============ 8. artifact（1 附件 + 1 导出）============

INSERT INTO artifact (artifact_id, tenant_id, user_id, session_id, kind, name, size_bytes, storage_uri, mime_type) VALUES
  ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'sess-002', 'attachment', '张三 · CT 报告.pdf', 524288, 'users/alice/attachments/ct-zhangsan.pdf', 'application/pdf'),
  ('77777777-7777-7777-7777-777777777772', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'sess-002', 'export', '张三 · 病历摘要.md', 16384, 'users/alice/exports/summary-zhangsan.md', 'text/markdown');

-- ============ 9. plugin（system 级 + 租户级 + 用户级各 1）============

INSERT INTO plugin (plugin_id, version, scope, tenant_id, user_id, enabled) VALUES
  ('@deepseek-ai/dsh-storage-postgres', '0.1.0', 'system', NULL, NULL, true),
  ('@acme/tenant-branding',             '1.2.0', 'tenant', '11111111-1111-1111-1111-111111111111', NULL, true),
  ('@acme/alice-personal-tool',         '0.3.1', 'user',   '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

-- ============ 10. audit_log（少量示例）============

INSERT INTO audit_log (tenant_id, actor_user_id, action, target_type, target_id, payload) VALUES
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'machine.tenants.ensure', 'tenant', '11111111-1111-1111-1111-111111111111', '{"source":"aims-panel"}'::jsonb),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspaces.ensure',     'workspace', '33333333-3333-3333-3333-333333333333', '{"biz_key":"patient.CURE001"}'::jsonb);