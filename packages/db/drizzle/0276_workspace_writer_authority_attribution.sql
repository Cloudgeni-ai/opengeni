-- deployment-mode: rolling
-- Migration 0276: every admitted persistable /workspace writer and every
-- retained process carries its own exact authority tuple - causal initiator,
-- initiating human, organization membership (the grant identity) and its
-- observed authorization revision, plus the session tenancy epoch/visibility
-- and owning membership that were true when the operation was admitted.
--
-- Before this migration only the `turn` actor was attributable, through
-- `session_turn_attempts` (migration 0222) and `session_turns` (migration
-- 0096). `direct` (API request) and `process` (retained yielded shell) actors
-- recorded no owner, no causal initiator, no visibility and no authority
-- epoch, so organization offboarding (migration 0263) had nothing to fence and
-- `docs/organization-tenancy.md` explicitly deferred that attribution. This is
-- that attribution; it stores identities and epochs only and never a secret
-- value.
--
-- Rolling window. The new columns are nullable or carry the explicit
-- `legacy_unattributed` / `unattributed-legacy` sentinels, so a pre-0276
-- API/worker image keeps inserting admissions and retained processes exactly
-- as before and lands on the sentinel. Historical and mixed-window rows are
-- promoted only where the frozen turn/attempt snapshot makes the authority
-- unambiguous; nothing is inferred for a `direct` or `process` row that never
-- had an owner. A sentinel row is refused by NEW admission in the post-0276
-- application (fail closed), but the live provider process behind it is never
-- terminated by this migration or by that refusal - the user sees a typed
-- rejection on the next write instead of losing a running shell.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- 1. Expand -------------------------------------------------------------

ALTER TABLE "sandbox_workspace_mutation_admissions"
  ADD COLUMN IF NOT EXISTS "initiator_kind" text NOT NULL DEFAULT 'legacy_unattributed',
  ADD COLUMN IF NOT EXISTS "initiator_subject_id" text NOT NULL DEFAULT 'unattributed-legacy',
  ADD COLUMN IF NOT EXISTS "initiating_human_subject_id" text,
  ADD COLUMN IF NOT EXISTS "initiator_organization_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "initiator_authorization_revision" bigint,
  ADD COLUMN IF NOT EXISTS "authority_epoch" integer,
  ADD COLUMN IF NOT EXISTS "authority_visibility" text,
  ADD COLUMN IF NOT EXISTS "authority_owner_organization_membership_id" uuid;

ALTER TABLE "sandbox_retained_processes"
  ADD COLUMN IF NOT EXISTS "initiator_kind" text NOT NULL DEFAULT 'legacy_unattributed',
  ADD COLUMN IF NOT EXISTS "initiator_subject_id" text NOT NULL DEFAULT 'unattributed-legacy',
  ADD COLUMN IF NOT EXISTS "initiating_human_subject_id" text,
  ADD COLUMN IF NOT EXISTS "initiator_organization_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "initiator_authorization_revision" bigint,
  ADD COLUMN IF NOT EXISTS "authority_epoch" integer,
  ADD COLUMN IF NOT EXISTS "authority_visibility" text,
  ADD COLUMN IF NOT EXISTS "authority_owner_organization_membership_id" uuid;

-- The grant identity is a real membership row in the same organization. It is
-- never cascaded away: offboarding keeps the membership row (revoked) exactly
-- so retained authority evidence stays resolvable.
ALTER TABLE "sandbox_workspace_mutation_admissions"
  ADD CONSTRAINT "sandbox_workspace_mutation_admissions_initiator_membership_fk"
    FOREIGN KEY ("initiator_organization_membership_id", "account_id")
    REFERENCES "organization_memberships" ("id", "account_id")
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "sandbox_workspace_mutation_admissions_authority_owner_fk"
    FOREIGN KEY ("authority_owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships" ("id", "account_id")
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE "sandbox_retained_processes"
  ADD CONSTRAINT "sandbox_retained_processes_initiator_membership_fk"
    FOREIGN KEY ("initiator_organization_membership_id", "account_id")
    REFERENCES "organization_memberships" ("id", "account_id")
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "sandbox_retained_processes_authority_owner_fk"
    FOREIGN KEY ("authority_owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships" ("id", "account_id")
    ON DELETE RESTRICT NOT VALID;

-- 2. Promote the unambiguous historical rows ----------------------------
-- Only a `turn` actor has a frozen accepted-authority snapshot. Copy it
-- verbatim: the attempt owns tenancy epoch/visibility/owner membership and the
-- logical turn owns the causal initiator. Nothing here derives an owner from
-- the session creator, the current membership table, or provenance metadata.

UPDATE "sandbox_workspace_mutation_admissions" AS admission
SET
  "initiator_kind" = turn."initiator_kind",
  "initiator_subject_id" = turn."initiator_subject_id",
  "initiating_human_subject_id" = turn."initiating_human_subject_id",
  "authority_epoch" = attempt."authority_epoch",
  "authority_visibility" = attempt."authority_visibility",
  "authority_owner_organization_membership_id" =
    attempt."authority_owner_organization_membership_id"
FROM "session_turn_attempts" AS attempt
JOIN "session_turns" AS turn
  ON turn."workspace_id" = attempt."workspace_id"
  AND turn."id" = attempt."turn_id"
WHERE admission."actor_kind" = 'turn'
  AND admission."initiator_kind" = 'legacy_unattributed'
  AND attempt."workspace_id" = admission."workspace_id"
  AND attempt."id" = admission."attempt_id"
  AND admission."turn_id" = attempt."turn_id";

UPDATE "sandbox_retained_processes" AS process
SET
  "initiator_kind" = turn."initiator_kind",
  "initiator_subject_id" = turn."initiator_subject_id",
  "initiating_human_subject_id" = turn."initiating_human_subject_id",
  "authority_epoch" = attempt."authority_epoch",
  "authority_visibility" = attempt."authority_visibility",
  "authority_owner_organization_membership_id" =
    attempt."authority_owner_organization_membership_id"
FROM "session_turn_attempts" AS attempt
JOIN "session_turns" AS turn
  ON turn."workspace_id" = attempt."workspace_id"
  AND turn."id" = attempt."turn_id"
WHERE process."owner_actor_kind" = 'turn'
  AND process."initiator_kind" = 'legacy_unattributed'
  AND attempt."workspace_id" = process."workspace_id"
  AND attempt."id" = process."owner_attempt_id"
  AND process."owner_turn_id" = attempt."turn_id";

-- The membership that authorized a promoted human initiator is resolvable
-- exactly (organization_memberships is unique per account+subject). A machine
-- or service initiator legitimately has none. The observed revision is audit
-- evidence, not a fence: a role change is not a revocation.
UPDATE "sandbox_workspace_mutation_admissions" AS admission
SET
  "initiator_organization_membership_id" = membership."id",
  "initiator_authorization_revision" = membership."authorization_revision"
FROM "organization_memberships" AS membership
WHERE admission."initiator_kind" <> 'legacy_unattributed'
  AND admission."initiating_human_subject_id" IS NOT NULL
  AND admission."initiator_organization_membership_id" IS NULL
  AND membership."account_id" = admission."account_id"
  AND membership."subject_id" = admission."initiating_human_subject_id";

UPDATE "sandbox_retained_processes" AS process
SET
  "initiator_organization_membership_id" = membership."id",
  "initiator_authorization_revision" = membership."authorization_revision"
FROM "organization_memberships" AS membership
WHERE process."initiator_kind" <> 'legacy_unattributed'
  AND process."initiating_human_subject_id" IS NOT NULL
  AND process."initiator_organization_membership_id" IS NULL
  AND membership."account_id" = process."account_id"
  AND membership."subject_id" = process."initiating_human_subject_id";

-- 3. Contract -----------------------------------------------------------
-- Either the row is an explicit unattributed legacy row (every authority field
-- absent, so it can never masquerade as a partial grant), or it carries a
-- complete tenancy tuple. A private session must name its owning membership,
-- exactly as `sessions` and `session_turn_attempts` already require.

ALTER TABLE "sandbox_workspace_mutation_admissions"
  ADD CONSTRAINT "sandbox_workspace_mutation_admissions_authority_check"
  CHECK (
    (
      "initiator_kind" = 'legacy_unattributed'
      AND "initiator_subject_id" = 'unattributed-legacy'
      AND "initiating_human_subject_id" IS NULL
      AND "initiator_organization_membership_id" IS NULL
      AND "initiator_authorization_revision" IS NULL
      AND "authority_epoch" IS NULL
      AND "authority_visibility" IS NULL
      AND "authority_owner_organization_membership_id" IS NULL
    ) OR (
      "initiator_kind" IN ('subject', 'service')
      AND length(btrim("initiator_subject_id")) BETWEEN 1 AND 1024
      AND "initiator_subject_id" <> 'unattributed-legacy'
      AND (
        "initiating_human_subject_id" IS NULL
        OR length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
      )
      AND (
        "initiator_organization_membership_id" IS NULL
        OR "initiating_human_subject_id" IS NOT NULL
      )
      AND (
        "initiator_authorization_revision" IS NULL
        OR (
          "initiator_authorization_revision" > 0
          AND "initiator_organization_membership_id" IS NOT NULL
        )
      )
      AND "authority_epoch" > 0
      AND "authority_visibility" IN ('user_private', 'workspace_shared')
      AND (
        "authority_visibility" <> 'user_private'
        OR "authority_owner_organization_membership_id" IS NOT NULL
      )
    )
  ) NOT VALID;

ALTER TABLE "sandbox_retained_processes"
  ADD CONSTRAINT "sandbox_retained_processes_authority_check"
  CHECK (
    (
      "initiator_kind" = 'legacy_unattributed'
      AND "initiator_subject_id" = 'unattributed-legacy'
      AND "initiating_human_subject_id" IS NULL
      AND "initiator_organization_membership_id" IS NULL
      AND "initiator_authorization_revision" IS NULL
      AND "authority_epoch" IS NULL
      AND "authority_visibility" IS NULL
      AND "authority_owner_organization_membership_id" IS NULL
    ) OR (
      "initiator_kind" IN ('subject', 'service')
      AND length(btrim("initiator_subject_id")) BETWEEN 1 AND 1024
      AND "initiator_subject_id" <> 'unattributed-legacy'
      AND (
        "initiating_human_subject_id" IS NULL
        OR length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
      )
      AND (
        "initiator_organization_membership_id" IS NULL
        OR "initiating_human_subject_id" IS NOT NULL
      )
      AND (
        "initiator_authorization_revision" IS NULL
        OR (
          "initiator_authorization_revision" > 0
          AND "initiator_organization_membership_id" IS NOT NULL
        )
      )
      AND "authority_epoch" > 0
      AND "authority_visibility" IN ('user_private', 'workspace_shared')
      AND (
        "authority_visibility" <> 'user_private'
        OR "authority_owner_organization_membership_id" IS NOT NULL
      )
    )
  ) NOT VALID;

ALTER TABLE "sandbox_workspace_mutation_admissions"
  VALIDATE CONSTRAINT "sandbox_workspace_mutation_admissions_authority_check";
ALTER TABLE "sandbox_retained_processes"
  VALIDATE CONSTRAINT "sandbox_retained_processes_authority_check";

ALTER TABLE "sandbox_workspace_mutation_admissions"
  VALIDATE CONSTRAINT "sandbox_workspace_mutation_admissions_initiator_membership_fk";
ALTER TABLE "sandbox_workspace_mutation_admissions"
  VALIDATE CONSTRAINT "sandbox_workspace_mutation_admissions_authority_owner_fk";
ALTER TABLE "sandbox_retained_processes"
  VALIDATE CONSTRAINT "sandbox_retained_processes_initiator_membership_fk";
ALTER TABLE "sandbox_retained_processes"
  VALIDATE CONSTRAINT "sandbox_retained_processes_authority_owner_fk";

-- 4. Revocation sweep support -------------------------------------------
-- Membership revocation and workspace-membership removal need the live
-- unsettled writers owned by one exact grant identity, cheaply.

CREATE INDEX IF NOT EXISTS "sandbox_workspace_mutation_admissions_initiator_idx"
  ON "sandbox_workspace_mutation_admissions"
    ("account_id", "initiator_organization_membership_id")
  WHERE "settled_at" IS NULL;

CREATE INDEX IF NOT EXISTS "sandbox_retained_processes_initiator_idx"
  ON "sandbox_retained_processes"
    ("account_id", "initiator_organization_membership_id")
  WHERE "state" = 'active';

CREATE INDEX IF NOT EXISTS "sandbox_retained_processes_initiating_human_idx"
  ON "sandbox_retained_processes" ("account_id", "initiating_human_subject_id")
  WHERE "state" = 'active';

COMMENT ON COLUMN "sandbox_workspace_mutation_admissions"."initiator_kind" IS
  'Causal principal kind for this admission: subject | service, or the '
  'legacy_unattributed sentinel for a pre-0276 row whose authority was never '
  'recorded. The sentinel is refused by new admission and is never written by '
  'a post-0276 writer.';
COMMENT ON COLUMN "sandbox_workspace_mutation_admissions"."authority_epoch" IS
  'Session tenancy authority epoch observed when the operation was admitted. '
  'Identity and epoch only - never a secret value.';
COMMENT ON COLUMN "sandbox_retained_processes"."initiator_kind" IS
  'Causal principal kind frozen when the process was retained. A '
  'legacy_unattributed process keeps running; only its next workspace mutation '
  'is refused.';
