-- The user_code → (account_id, workspace_id) resolver for the click-Grant approve
-- page lookup (self-hosted enrollment UX, design 11 §B.1). Companion to the
-- device_code resolver in 0025 (resolve_device_enrollment_request).
--
-- WHY a SECURITY DEFINER resolver: POST /v1/enrollments/device/lookup is the
-- approve page reading machine details for a user_code WITHOUT a workspace in the
-- path — the user_code is globally unique among LIVE (status='pending') rows (the
-- 0025 partial unique index device_enrollment_requests_user_code_pending_idx). A
-- scoped opengeni_app connection is under FORCE RLS and cannot read a row to learn
-- which workspace it belongs to, so — exactly like 0025's device_code resolver —
-- this returns ONLY the (account_id, workspace_id) for the PENDING row matching the
-- code. The DAO then re-reads the FULL row under the resolved workspace's RLS scope
-- and the ROUTE re-checks the caller holds an enrollments:read grant in THAT
-- workspace, so the user_code is the capability and no broad read escapes RLS.
--
-- PENDING-ONLY: the partial unique index guarantees AT MOST ONE pending row per
-- user_code, so the resolver is unambiguous; a terminal (approved/denied/consumed)
-- row's recycled code is intentionally invisible here (lookup is for the live
-- approve decision only).
--
-- ROLLBACK (forward-only repo, but cleanly reversible):
--   DROP FUNCTION IF EXISTS opengeni_private.resolve_pending_device_enrollment_by_user_code(text);

CREATE OR REPLACE FUNCTION opengeni_private.resolve_pending_device_enrollment_by_user_code(
  p_user_code text
)
RETURNS TABLE (account_id uuid, workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
-- EMBED-SAFE (see 0017/0025): no pinned 'public' search_path -- inherit the caller's path so
-- device_enrollment_requests resolves in public (standalone) OR the dedicated schema (embed).
-- A pinned `public` path also fails CREATE-time body validation (check_function_bodies) under
-- the dedicated-schema migrate, since device_enrollment_requests lives in <schema>, not public.
AS $$
  SELECT d.account_id, d.workspace_id
  FROM device_enrollment_requests d
  WHERE d.user_code = p_user_code
    AND d.status = 'pending'
  LIMIT 1
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_pending_device_enrollment_by_user_code(text) TO opengeni_app;
  END IF;
END $$;
