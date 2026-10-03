-- deployment-mode: rolling
--
-- Codex plan entitlement. A connected ChatGPT account can change plan (for
-- example Pro to Free) without reconnecting. Record when the plan was last
-- observed from the provider, the most recent plan change (the plan before it
-- and when it was observed), and which product models the CURRENT plan was
-- proven not to include. All columns are nullable additive metadata that older
-- binaries ignore. The exclusion names the plan it was observed under, so any
-- later plan observation that reports another plan retires it, and each
-- excluded model carries the time of its refusal so it can expire.
--
-- Inherited organization credentials are maintained from workspace runtime
-- context under a column-limited guard. Widen that guard only so a plan
-- observation (plan_checked_at advancing) may rewrite plan_type and the plan
-- change record; every other identity and administration column stays
-- organization-administered.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN "plan_checked_at" timestamptz,
  ADD COLUMN "plan_previous_type" text,
  ADD COLUMN "plan_changed_at" timestamptz,
  ADD COLUMN "plan_entitlement_exclusion" jsonb,
  ADD CONSTRAINT "codex_credentials_plan_previous_type_len_chk" CHECK (
    "plan_previous_type" IS NULL OR char_length("plan_previous_type") BETWEEN 1 AND 128
  ),
  ADD CONSTRAINT "codex_credentials_plan_entitlement_exclusion_shape_chk" CHECK (
    "plan_entitlement_exclusion" IS NULL
    OR CASE
      WHEN jsonb_typeof("plan_entitlement_exclusion") = 'object'
        AND jsonb_typeof("plan_entitlement_exclusion" -> 'planType') = 'string'
        AND jsonb_typeof("plan_entitlement_exclusion" -> 'models') = 'array'
      THEN
        jsonb_array_length("plan_entitlement_exclusion" -> 'models') BETWEEN 1 AND 64
        AND pg_column_size("plan_entitlement_exclusion") <= 16384
      ELSE false
    END
  );

CREATE OR REPLACE FUNCTION opengeni_private.enforce_organization_codex_runtime_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF OLD.authority_scope IS DISTINCT FROM 'organization'
    OR opengeni_private.current_workspace_id() IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
    OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.organization_user_resource_authority_id IS DISTINCT FROM OLD.organization_user_resource_authority_id
    OR NEW.organization_user_resource_kind IS DISTINCT FROM OLD.organization_user_resource_kind
    OR NEW.organization_user_resource_authority_generation IS DISTINCT FROM OLD.organization_user_resource_authority_generation
    OR NEW.chatgpt_account_id IS DISTINCT FROM OLD.chatgpt_account_id
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    -- A provider plan observation may rewrite plan_type and the plan change
    -- record, but only together with a new plan_checked_at stamp.
    OR (
      (
        NEW.plan_type IS DISTINCT FROM OLD.plan_type
        OR NEW.plan_previous_type IS DISTINCT FROM OLD.plan_previous_type
        OR NEW.plan_changed_at IS DISTINCT FROM OLD.plan_changed_at
      )
      AND (
        NEW.plan_checked_at IS NULL
        OR NEW.plan_checked_at IS NOT DISTINCT FROM OLD.plan_checked_at
      )
    )
    OR NEW.is_fedramp IS DISTINCT FROM OLD.is_fedramp
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.account_email IS DISTINCT FROM OLD.account_email
    OR NEW.allocator_enabled IS DISTINCT FROM OLD.allocator_enabled
    OR NEW.allocator_version IS DISTINCT FROM OLD.allocator_version
    OR NEW.allocator_updated_by_subject_id IS DISTINCT FROM OLD.allocator_updated_by_subject_id
    OR NEW.allocator_updated_at IS DISTINCT FROM OLD.allocator_updated_at
    OR NEW.connected_by_subject_id IS DISTINCT FROM OLD.connected_by_subject_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'organization Codex credential management requires organization administration'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.credential_encrypted IS DISTINCT FROM OLD.credential_encrypted
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.last_refresh_at IS DISTINCT FROM OLD.last_refresh_at
    OR NEW.version IS DISTINCT FROM OLD.version
  THEN
    IF NEW.credential_encrypted IS NOT DISTINCT FROM OLD.credential_encrypted
      OR NEW.version IS DISTINCT FROM OLD.version + 1
      OR NEW.last_refresh_at IS NULL
      OR NEW.last_refresh_at IS NOT DISTINCT FROM OLD.last_refresh_at
      OR NEW.status IS DISTINCT FROM 'active'
      OR NEW.last_error IS NOT NULL
      OR NEW.primary_used_percent IS DISTINCT FROM OLD.primary_used_percent
      OR NEW.primary_reset_at IS DISTINCT FROM OLD.primary_reset_at
      OR NEW.secondary_used_percent IS DISTINCT FROM OLD.secondary_used_percent
      OR NEW.secondary_reset_at IS DISTINCT FROM OLD.secondary_reset_at
      OR NEW.usage_checked_at IS DISTINCT FROM OLD.usage_checked_at
      OR NEW.exhausted_until IS DISTINCT FROM OLD.exhausted_until
      OR NEW.reset_credit_available_count IS DISTINCT FROM OLD.reset_credit_available_count
      OR NEW.reset_credits_checked_at IS DISTINCT FROM OLD.reset_credits_checked_at
      OR NEW.selection_count IS DISTINCT FROM OLD.selection_count
      OR NEW.last_selected_at IS DISTINCT FROM OLD.last_selected_at
    THEN
      RAISE EXCEPTION 'organization Codex runtime token refresh has an invalid mutation shape'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$body$;
