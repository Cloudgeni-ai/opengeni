/**
 * TEST ONLY: retired Codex persistence used to construct and probe historical
 * database states. Snapshot source: main 8c43a921512078d302f671ae590d43645669f88d.
 * Never import this module from production. The runtime no-legacy guard enforces
 * that boundary. Current core authority and migration tests use production APIs.
 */




import { lockTurnAttemptWriteFenceTx } from "../../src/session-attempt-fence";





import { parentOutboxAuthorityTx } from "../../src/child-outbox-authority";


import {
  claudeSubscriptionAccountRepository,
  claudeSubscriptionTables,
} from "../../src/claude-subscription-accounts";




import { heartbeatSubscriptionCredentialLeaseUntil } from "./legacy-codex-heartbeat";













import { sessionAttemptPendingWritersSql } from "../../src/session-attempt-writers";
import { childLifecycleEvidenceCandidatesSql } from "../../src/session-meaningful-events";
import { boundedChildLifecycleEvidence } from "../../src/child-read-reconciliation";


import { unresolvedCodexCredentialFailures } from "../../src/codex-failure-eligibility";
import {
  mergeCodexPlanEntitlementExclusion,
  readCodexPlanEntitlementExclusion,
  serializeCodexPlanEntitlementExclusion,
} from "../../src/codex-plan-entitlement";
import type {
  CodexAccountStatus,
  CodexRotationSettings,
  EffectiveCodexSubscriptionSource,
  WorkspaceCodexSubscriptionMode,
  WorkspaceCodexSubscriptionSource,
} from "../../src/codex-account-types";


import { CODEX_CAPACITY_RECOVERY_KEY, CODEX_CAPACITY_FALSE_RESUMPTION_LIMIT, readCodexCapacityRecovery, codexFalseResumptionBackoffMs } from "../../src/codex-capacity-recovery";





import { subscriptionPoolWorkerSubject, withSubscriptionPoolSessionAccess, withTemporaryPoolSessionAccessInTransaction } from "../../src/subscription-session-access";



import { codexSelectionDiagnostics } from "../../src/codex-selection-diagnostics";



import { assignedConnectionDefault } from "../../src/model-connection-access";



import { timingSafeEqual } from "node:crypto";
import { scheduledRunHumanWaitsInRlsContext } from "../../src/scheduled-human-wait";











import { SESSION_SYSTEM_UPDATE_WAKE_CLASS, type ChildLifecycleSystemUpdateKind } from "@opengeni/contracts";

import type { SessionEvent, SessionEventType, SessionSystemUpdateKind, SystemUpdateClassification, SessionTurnSource } from "@opengeni/contracts";



import { cancelTurnInteractionInterventionsInTransaction, settleSessionMaintenanceInTransaction } from "../../src/browser-auth";
import { stableJson, XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { approvalIdentifier, metadataWithCodexCredentialPolicySnapshotV1, readCodexCredentialPolicySnapshotV1, readTurnExecutionPolicyV1, SessionSystemUpdatePayload, CodexCredentialPolicySnapshotV1 } from "@opengeni/contracts";
import { ClaudeSubscriptionCredential, environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";


import { CODEX_CLIENT_VERSION, CodexAppsCredentialUnavailable, CodexReloginRequired, codexPlanKey, refreshCodexToken, type CodexFetch } from "@opengeni/codex";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";



import { decryptEnvironmentValue, encryptEnvironmentValue } from "../../src/environment-crypto";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "../../src/lossless-json";


import { nestedPostgresSqlState } from "../../src/persistence-errors";

import { closePendingSessionToolCallsInTransaction } from "../../src/session-tool-call-settlement";
import { closeSessionTurnAttemptInTransaction, evaluateSessionControl, lockSessionEventWriteRows, lockWorkspaceInferenceControl, assertSessionAuthoritySnapshot, sessionAuthoritySnapshotMatchesSession, SessionControlInvariantError } from "../../src/session-control";



import { projectSessionRealtimeDelegationTerminalInTransaction } from "../../src/session-realtime-ledger";


import * as schema from "../../src/schema";
import { childLifecycleNoticesEnabled, childWaitingCapacityDedupeKey, childWaitingCapacitySummary } from "../../src/child-lifecycle-notices";










import { rawRows, retrySessionActivityRls, setRlsContext, setSubjectRlsContext, withRlsContext, withSessionActivityRlsContext, withSessionActivitySavepoint, withWorkspaceRls, withWorkspaceSessionActivityRls, withWorkspaceSubjectRls, withWorkspaceSubjectSessionActivityRls, type Database, type SessionActivityDatabase } from "../../src/database";
import {
  buildCodexTokenResolver as buildCodexTokenResolverCore,
  fetchCodexRateLimitResetCreditsForAccount as fetchCodexRateLimitResetCreditsForAccountCore,
  fetchCodexUsageForAccount as fetchCodexUsageForAccountCore,
  recheckCodexCredentialPlan as recheckCodexCredentialPlanCore,
  type CodexAccountUsageSnapshot,
  type CodexAuthDeps,
  type CodexCredentialCooldownKind,
  type CodexCredentialForRun,
  type CodexCredentialTokens,
} from "../../src/codex-token-resolver";


import { xaiSubscriptionRepository, xaiCredentialWorkspacePredicate, xaiRotationWorkspacePredicate } from "../../src/xai-subscription";

import { UpsertCodexSubscriptionCredentialResult, CodexCapacityWakeTarget, enqueueSessionWorkflowWakeInTransaction, CodexAppsSettings, CodexAppsCredentialAuthorization, CodexAppsAuthorizationRevokedError, DesignateCodexAppsCredentialResult, ClearCodexAppsCredentialResult, CodexAcceptedLeaseAuthority, CodexCapacityMutationResult, CodexCredentialStatus, CodexLeaseAccountStatus, CodexCredentialLeaseCandidateFilter, CodexCredentialLeaseCandidateFilterResult, CodexCredentialLeaseSelectionContext, CodexCredentialLeaseSessionState, CodexCredentialLeasePolicyScopeResolver, CodexCredentialLeaseSelection, CodexCredentialLeaseResult, CODEX_CREDENTIAL_LEASE_TTL_MS, CodexCredentialLeaseAttemptFencedError, CodexCredentialFailoverExhaustedError, CodexCapacityWait, CodexCapacityWaitStatus, CodexCapacityResetKind, codexCapacityRefreshBackoffMs, ArmCodexCapacityWaitResult, CodexCapacitySelectionContext, CodexCapacityAvailabilityDecision, ReconcileCodexCapacityWaitResult, CodexPinSource, CodexCredentialLeaseQuarantine, CodexCredentialLeaseQuarantineResult, CodexAllocatorUpdateResult, CodexExtraCreditsUpdateResult, CodexResetRedemptionRecovery, CodexResetRedemptionOutcome, CodexResetRedemptionAttempt, CODEX_RESET_REDEMPTION_OUTCOMES, CodexResetRedemptionStatus, CodexFinalizationUsageAuthority, CodexRotationStrategy, CODEX_ROTATION_STRATEGIES, SessionCodexState, SetSessionCodexPinOptions, AppendEventInput, appendSessionEventsForTurnAttempt, SettleCodexCredentialLeaseLossResult, SettleCodexCredentialFailoverResult, CodexAppsRequestAuth, CodexResetRedemptionCredentialAuthority, CodexResetCreditFence, ClaimCodexResetRedemptionResult, AdoptCodexResetRedemptionResult, FenceCodexResetRedemptionSendResult, CodexResetRedemptionSendNotReadyReason, SessionWorkPeek, SubscriptionCoreCodexCapacityWait, subscriptionCoreCodexCapacityWaitRef, XaiCapacityWait, CODEX_CAPACITY_REFRESH_MIN_MS, XaiCredentialLeaseQuarantine, ArmXaiCapacityWaitResult, ReconcileXaiCapacityWaitResult, SandboxSetupOutcomeUnknown, SandboxSetupRecoveryExhausted, SANDBOX_SETUP_RECOVERY_LIMIT, SandboxLifecycleWait, SandboxLeaseLiveness, CONSUMED_CHILD_ANSWERS_METADATA_KEY, IDLE_COMMAND_CONTAINMENT_REASON } from "../../src/index";
type SessionEventInsertWithPayload = typeof schema.sessionEvents.$inferInsert & {
  payload: unknown;
};

const workspaceCodexOrganizationInheritanceAvailable = new Map<string, boolean>();

function rememberWorkspaceCodexOrganizationInheritance(
  workspaceId: string,
  available: boolean,
): void {
  workspaceCodexOrganizationInheritanceAvailable.set(workspaceId, available);
  if (workspaceCodexOrganizationInheritanceAvailable.size > 10_000) {
    const oldest = workspaceCodexOrganizationInheritanceAvailable.keys().next().value;
    if (oldest) workspaceCodexOrganizationInheritanceAvailable.delete(oldest);
  }
}

async function queryWorkspaceCodexSubscriptionSource(
  scopedDb: Database,
  workspaceId: string,
): Promise<WorkspaceCodexSubscriptionSource> {
  const rows = await scopedDb.execute<{
    account_id: string;
    workspace_kind: "personal" | "shared";
    mode: WorkspaceCodexSubscriptionMode;
    effective_source: EffectiveCodexSubscriptionSource;
    workspace_available: boolean;
    organization_available: boolean;
  }>(sql`
      select workspace.account_id,
        get_workspace_kind(workspace.account_id, workspace.id) as workspace_kind,
        coalesce(preference.mode, 'automatic') as mode,
        resolve_workspace_codex_subscription_source(workspace.account_id, workspace.id)
          as effective_source,
        exists (
          select 1 from codex_subscription_credentials credential
          where credential.account_id = workspace.account_id
            and credential.workspace_id = workspace.id
            and credential.authority_scope in ('workspace', 'user')
        ) as workspace_available,
        exists (
          select 1 from codex_subscription_credentials credential
          where credential.account_id = workspace.account_id
            and credential.organization_id = workspace.account_id
            and credential.authority_scope = 'organization'
        ) as organization_available
      from workspaces workspace
      left join workspace_codex_subscription_preferences preference
        on preference.account_id = workspace.account_id
       and preference.workspace_id = workspace.id
      where workspace.id = ${workspaceId}
      limit 1
    `);
  const row = rows[0];
  if (!row) throw new Error(`workspace not found for Codex source: ${workspaceId}`);
  return {
    accountId: row.account_id,
    workspaceId,
    workspaceKind: row.workspace_kind,
    mode: row.mode,
    effectiveSource: row.effective_source,
    workspaceAvailable: row.workspace_available,
    organizationAvailable: row.organization_available,
  };
}

async function queryLegacyWorkspaceCodexSubscriptionSource(
  scopedDb: Database,
  workspaceId: string,
): Promise<WorkspaceCodexSubscriptionSource> {
  const rows = await scopedDb.execute<{
    account_id: string;
    workspace_available: boolean;
  }>(sql`
    select workspace.account_id,
      exists (
        select 1 from codex_subscription_credentials credential
        where credential.account_id = workspace.account_id
          and credential.workspace_id = workspace.id
      ) as workspace_available
    from workspaces workspace
    where workspace.id = ${workspaceId}
    limit 1
  `);
  const row = rows[0];
  if (!row) throw new Error(`workspace not found for Codex source: ${workspaceId}`);
  return {
    accountId: row.account_id,
    workspaceId,
    workspaceKind: "shared",
    mode: "automatic",
    effectiveSource: "workspace",
    workspaceAvailable: row.workspace_available,
    organizationAvailable: false,
  };
}

async function getWorkspaceCodexSubscriptionSourceScoped(
  scopedDb: Database,
  workspaceId: string,
): Promise<WorkspaceCodexSubscriptionSource> {
  const known = workspaceCodexOrganizationInheritanceAvailable.get(workspaceId);
  if (known === false) {
    return await queryLegacyWorkspaceCodexSubscriptionSource(scopedDb, workspaceId);
  }
  if (known === true) {
    return await queryWorkspaceCodexSubscriptionSource(scopedDb, workspaceId);
  }
  try {
    const source = await scopedDb.transaction(async (savepoint) =>
      queryWorkspaceCodexSubscriptionSource(savepoint as unknown as Database, workspaceId),
    );
    rememberWorkspaceCodexOrganizationInheritance(workspaceId, true);
    return source;
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state !== "42P01" && state !== "42703" && state !== "42883") throw error;
    rememberWorkspaceCodexOrganizationInheritance(workspaceId, false);
    return await queryLegacyWorkspaceCodexSubscriptionSource(scopedDb, workspaceId);
  }
}

export async function getWorkspaceCodexSubscriptionSource(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceCodexSubscriptionSource> {
  return await withWorkspaceRls(db, workspaceId, (scopedDb) =>
    getWorkspaceCodexSubscriptionSourceScoped(scopedDb, workspaceId),
  );
}

async function lockWorkspaceCodexSubscriptionSource(
  scopedDb: Database,
  workspaceId: string,
): Promise<void> {
  await scopedDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`codex-subscription-source:${workspaceId}`}, 0))`,
  );
}

async function codexSourceForTurn(
  tx: Database,
  workspaceId: string,
  turnId: string,
  fallback: EffectiveCodexSubscriptionSource,
): Promise<EffectiveCodexSubscriptionSource> {
  const [turn] = await tx
    .select({ metadata: schema.sessionTurns.metadata })
    .from(schema.sessionTurns)
    .where(
      and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId)),
    )
    .limit(1);
  const accepted = readCodexCredentialPolicySnapshotV1(turn?.metadata);
  if (accepted.kind === "valid" && accepted.policy.source) return accepted.policy.source;
  const rows = await tx.execute<{ source: EffectiveCodexSubscriptionSource }>(sql`
    select source from codex_turn_source_bindings
    where workspace_id = ${workspaceId} and turn_id = ${turnId}
  `);
  return rows[0]?.source ?? fallback;
}

async function lockOrganizationMembershipLifecycle(
  scopedDb: Database,
  accountId: string,
): Promise<void> {
  await scopedDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
  );
}

async function captureLegacyCodexTurnSources(
  scopedDb: Database,
  workspaceId: string,
): Promise<void> {
  await scopedDb.execute(sql`
    select capture_legacy_codex_turn_sources(
      opengeni_private.current_account_id(), ${workspaceId}::uuid
    )
  `);
}

function codexCredentialPoolCondition(input: {
  accountId: string;
  workspaceId: string;
  source: Exclude<EffectiveCodexSubscriptionSource, "disabled">;
}): SQL {
  return input.source === "organization"
    ? and(
        eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
        eq(schema.codexSubscriptionCredentials.organizationId, input.accountId),
        eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
      )!
    : and(
        eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
        eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
        inArray(schema.codexSubscriptionCredentials.authorityScope, ["workspace", "user"]),
      )!;
}

async function effectiveCodexCredentialPoolCondition(
  scopedDb: Database,
  workspaceId: string,
): Promise<{ source: WorkspaceCodexSubscriptionSource; condition: SQL | null }> {
  const source = await getWorkspaceCodexSubscriptionSourceScoped(scopedDb, workspaceId);
  return {
    source,
    condition:
      source.effectiveSource === "disabled"
        ? null
        : codexCredentialPoolCondition({
            accountId: source.accountId,
            workspaceId,
            source: source.effectiveSource,
          }),
  };
}

async function lockOrganizationCodexSubscriptionSources(
  scopedDb: Database,
  accountId: string,
): Promise<string[]> {
  const rows = await scopedDb.execute<{ workspace_id: string }>(sql`
    select workspace_id
    from list_organization_codex_workspace_ids(${accountId}::uuid)
    order by workspace_id
  `);
  const workspaceIds = rows.map((row: { workspace_id: string }) => row.workspace_id);
  for (const workspaceId of workspaceIds) {
    // Credential deletion clears session pins/last-used references through FK
    // SET NULL, including references in Personal or no-longer-inheriting
    // workspaces. Fence the complete authorized inventory before any source,
    // pool, or credential lock; the FK's session writes cannot acquire this
    // prefix after taking their row locks. Keep the UUID order across both
    // passes, matching ordinary workspace writers' tenancy -> source order.
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
    );
  }
  for (const workspaceId of workspaceIds) {
    // Organization credential mutations can change automatic routing in every
    // inheriting workspace. Acquire all workspace source locks before the
    // organization rotation row, matching normal acquisition's source -> pool
    // lock order and preventing a waiter from observing a half-cutover source.
    await lockWorkspaceCodexSubscriptionSource(scopedDb, workspaceId);
  }
  return workspaceIds;
}

async function captureOrganizationCodexSubscriptionSources(
  scopedDb: Database,
  accountId: string,
  workspaceIds: readonly string[],
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await setRlsContext(scopedDb, { accountId, workspaceId });
    await captureLegacyCodexTurnSources(scopedDb, workspaceId);
  }
  await setRlsContext(scopedDb, { accountId, workspaceId: null });
}

export async function setWorkspaceCodexSubscriptionModeInTransaction(
  scopedDb: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    mode: WorkspaceCodexSubscriptionMode;
    /** Compatibility hint only; database capture derives authority before credential writes. */
    effectiveSourceBeforeMutation?: EffectiveCodexSubscriptionSource;
  },
): Promise<WorkspaceCodexSubscriptionSource> {
  await lockWorkspaceCodexSubscriptionSource(scopedDb, input.workspaceId);
  const current = await getWorkspaceCodexSubscriptionSourceScoped(scopedDb, input.workspaceId);
  if (current.accountId !== input.accountId) {
    throw new Error("Codex source account does not match the workspace account");
  }
  await captureLegacyCodexTurnSources(scopedDb, input.workspaceId);
  let next = current;
  if (current.mode !== input.mode) {
    await scopedDb
      .insert(schema.workspaceCodexSubscriptionPreferences)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        mode: input.mode,
        updatedBySubjectId: input.subjectId,
      })
      .onConflictDoUpdate({
        target: schema.workspaceCodexSubscriptionPreferences.workspaceId,
        set: {
          mode: input.mode,
          updatedBySubjectId: input.subjectId,
          updatedAt: new Date(),
        },
      });
    next = await getWorkspaceCodexSubscriptionSourceScoped(scopedDb, input.workspaceId);
  }
  return next;
}

export async function setWorkspaceCodexSubscriptionMode(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    mode: WorkspaceCodexSubscriptionMode;
  },
): Promise<WorkspaceCodexSubscriptionSource> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, (scopedDb) =>
    setWorkspaceCodexSubscriptionModeInTransaction(scopedDb, input),
  );
}

export async function upsertCodexSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    credentialEncrypted: string; // v1 envelope of JSON {access_token, refresh_token, id_token}
    chatgptAccountId: string | null;
    scopes: string | null;
    planType: string | null;
    isFedramp: boolean;
    expiresAt: Date | null;
    lastRefreshAt: Date | null;
    accountEmail?: string | null;
    label?: string | null;
    /** Direct managed-cookie human who most recently connected this row. */
    connectedBySubjectId?: string | null;
  },
): Promise<UpsertCodexSubscriptionCredentialResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // Serialize both the initial partial-index insert and ownership-changing
      // reconnects for this exact provider account. The row lock is shared with
      // the final redemption-send fence: either reconnect wins before any send,
      // or it observes durable provider_started truth and cannot replace its
      // owning human while the upstream outcome is unresolved.
      await scopedDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`codex-credential-upsert:${input.workspaceId}:${input.chatgptAccountId ?? "null"}`}, 0))`,
      );
      const [existing] = input.chatgptAccountId
        ? await scopedDb
            .select({
              id: schema.codexSubscriptionCredentials.id,
              connectedBySubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
            })
            .from(schema.codexSubscriptionCredentials)
            .where(
              and(
                eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
                eq(schema.codexSubscriptionCredentials.chatgptAccountId, input.chatgptAccountId),
              ),
            )
            .for("update")
            .limit(1)
        : [];
      if (existing && existing.connectedBySubjectId !== (input.connectedBySubjectId ?? null)) {
        const [unresolved] = await scopedDb
          .select({ id: schema.codexResetRedemptionAttempts.id })
          .from(schema.codexResetRedemptionAttempts)
          .where(
            and(
              eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
              eq(schema.codexResetRedemptionAttempts.credentialId, existing.id),
              eq(schema.codexResetRedemptionAttempts.status, "provider_started"),
            ),
          )
          .limit(1);
        if (unresolved) {
          return {
            kind: "unresolved_redemption",
            id: existing.id,
            isNew: false,
          };
        }
      }
      const now = new Date();
      const [row] = await scopedDb
        .insert(schema.codexSubscriptionCredentials)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialEncrypted: input.credentialEncrypted,
          chatgptAccountId: input.chatgptAccountId,
          scopes: input.scopes,
          planType: input.planType,
          // Connecting reads the plan from the fresh id_token.
          planCheckedAt: input.planType === null ? null : now,
          planEntitlementExclusion: null,
          isFedramp: input.isFedramp,
          expiresAt: input.expiresAt,
          lastRefreshAt: input.lastRefreshAt,
          accountEmail: input.accountEmail ?? null,
          label: input.label ?? null,
          connectedBySubjectId: input.connectedBySubjectId ?? null,
          status: "active",
          lastError: null,
        })
        .onConflictDoUpdate({
          // The unique index is PARTIAL (WHERE chatgpt_account_id IS NOT NULL), so the
          // conflict target MUST repeat that predicate via targetWhere, else postgres
          // raises "no unique or exclusion constraint matching the ON CONFLICT".
          target: [
            schema.codexSubscriptionCredentials.workspaceId,
            schema.codexSubscriptionCredentials.chatgptAccountId,
          ],
          targetWhere: sql`chatgpt_account_id is not null`,
          set: {
            // account_id MUST be re-asserted on conflict. Omitting it leaves a stale
            // account_id on a row whose owning account changed (e.g. a reconnect
            // under a different grant), which makes the row RLS-INVISIBLE to every
            // subsequent scoped read — a permanent phantom "no active subscription".
            accountId: input.accountId,
            credentialEncrypted: input.credentialEncrypted,
            scopes: input.scopes,
            planType: input.planType,
            // A reconnect is a fresh plan observation; earlier model refusals
            // belonged to the replaced token family, but a plan change it
            // reveals stays recorded as evidence.
            planCheckedAt: input.planType === null ? null : now,
            ...(input.planType === null ? {} : codexPlanChangeRecordSet(input.planType, now)),
            planEntitlementExclusion: null,
            isFedramp: input.isFedramp,
            expiresAt: input.expiresAt,
            lastRefreshAt: input.lastRefreshAt,
            // Refresh the derived email; keep an existing user-chosen label (only seed
            // it when still null) so a re-connect never clobbers a rename.
            accountEmail: input.accountEmail ?? null,
            label: sql`coalesce(${schema.codexSubscriptionCredentials.label}, ${input.label ?? null})`,
            // Reconnect refreshes credential material, never ownership. A row
            // without an owner may be claimed by its first direct managed human;
            // after that, disconnect is the explicit ownership-reset boundary.
            connectedBySubjectId: sql`coalesce(${schema.codexSubscriptionCredentials.connectedBySubjectId}, ${input.connectedBySubjectId ?? null})`,
            status: "active",
            lastError: null,
            version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
            updatedAt: now,
          },
        })
        .returning({
          id: schema.codexSubscriptionCredentials.id,
          createdAt: schema.codexSubscriptionCredentials.createdAt,
          updatedAt: schema.codexSubscriptionCredentials.updatedAt,
        });
      // The upsert always returns exactly one row (insert or update).
      if (!row) {
        throw new Error("upsertCodexSubscriptionCredential returned no row");
      }
      // A fresh INSERT leaves created_at === updated_at (both the same per-txn db
      // now()). A conflict UPDATE stamps updated_at to our JS `now` while created_at
      // keeps the original (older) value, so the two diverge. This distinguishes
      // insert from update without a second read.
      const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
      return { kind: "upserted", id: row.id, isNew };
    },
  );
}

async function withOrganizationCodexAdministrator<T>(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
  use: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      // Shared-workspace creation and every organization membership lifecycle
      // writer use this canonical prefix. Hold it before the administration
      // overview and before any Codex workspace inventory so a new workspace
      // cannot commit after the source snapshot was captured.
      await lockOrganizationMembershipLifecycle(scopedDb, input.organizationId);
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await scopedDb.execute(sql`
        select get_organization_administration_overview(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId}
        )
      `);
      return await use(scopedDb);
    },
  );
}

export async function ensureOrganizationCodexRotationSettings(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<void> {
  await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    await scopedDb
      .insert(schema.organizationCodexRotationSettings)
      .values({ accountId: input.organizationId })
      .onConflictDoNothing({ target: schema.organizationCodexRotationSettings.accountId });
  });
}

export async function upsertOrganizationCodexSubscriptionCredential(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    credentialEncrypted: string;
    chatgptAccountId: string | null;
    scopes: string | null;
    planType: string | null;
    isFedramp: boolean;
    expiresAt: Date | null;
    lastRefreshAt: Date | null;
    accountEmail?: string | null;
    label?: string | null;
  },
): Promise<{ id: string; isNew: boolean; wakeTargets: CodexCapacityWakeTarget[] }> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-codex-upsert:${input.organizationId}:${input.chatgptAccountId ?? "null"}`}, 0))`,
    );
    const organizationWorkspaceIds = await lockOrganizationCodexSubscriptionSources(
      scopedDb,
      input.organizationId,
    );
    await captureOrganizationCodexSubscriptionSources(
      scopedDb,
      input.organizationId,
      organizationWorkspaceIds,
    );
    await scopedDb
      .insert(schema.organizationCodexRotationSettings)
      .values({ accountId: input.organizationId })
      .onConflictDoNothing({ target: schema.organizationCodexRotationSettings.accountId });
    const [settings] = await scopedDb
      .select({ activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .for("update")
      .limit(1);
    if (!settings) throw new Error("organization Codex rotation settings are unavailable");
    // Local administration has no managed-human reset-credit owner.
    // Keep the same attribution boundary as workspace Codex connections.
    const connectedBySubjectId = input.actorSubjectId.startsWith("user:")
      ? input.actorSubjectId
      : null;
    const now = new Date();
    const [row] = await scopedDb
      .insert(schema.codexSubscriptionCredentials)
      .values({
        accountId: input.organizationId,
        workspaceId: null,
        organizationId: input.organizationId,
        authorityScope: "organization",
        credentialEncrypted: input.credentialEncrypted,
        chatgptAccountId: input.chatgptAccountId,
        scopes: input.scopes,
        planType: input.planType,
        planCheckedAt: input.planType === null ? null : now,
        planEntitlementExclusion: null,
        isFedramp: input.isFedramp,
        expiresAt: input.expiresAt,
        lastRefreshAt: input.lastRefreshAt,
        accountEmail: input.accountEmail ?? null,
        label: input.label ?? null,
        connectedBySubjectId,
        status: "active",
        lastError: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.codexSubscriptionCredentials.organizationId,
          schema.codexSubscriptionCredentials.chatgptAccountId,
        ],
        targetWhere: sql`authority_scope = 'organization' and chatgpt_account_id is not null`,
        set: {
          credentialEncrypted: input.credentialEncrypted,
          scopes: input.scopes,
          planType: input.planType,
          planCheckedAt: input.planType === null ? null : now,
          ...(input.planType === null ? {} : codexPlanChangeRecordSet(input.planType, now)),
          planEntitlementExclusion: null,
          isFedramp: input.isFedramp,
          expiresAt: input.expiresAt,
          lastRefreshAt: input.lastRefreshAt,
          accountEmail: input.accountEmail ?? null,
          label: sql`coalesce(${schema.codexSubscriptionCredentials.label}, ${input.label ?? null})`,
          connectedBySubjectId: sql`coalesce(${connectedBySubjectId}, ${schema.codexSubscriptionCredentials.connectedBySubjectId})`,
          status: "active",
          lastError: null,
          version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
          updatedAt: now,
        },
      })
      .returning({
        id: schema.codexSubscriptionCredentials.id,
        createdAt: schema.codexSubscriptionCredentials.createdAt,
        updatedAt: schema.codexSubscriptionCredentials.updatedAt,
      });
    if (!row) throw new Error("organization Codex credential upsert returned no row");
    await scopedDb
      .update(schema.organizationCodexRotationSettings)
      .set({ activeCredentialId: row.id, updatedAt: now })
      .where(
        and(
          eq(schema.organizationCodexRotationSettings.accountId, input.organizationId),
          isNull(schema.organizationCodexRotationSettings.activeCredentialId),
        ),
      );
    const wakeTargets = await wakeOrganizationCodexCapacityWaitersInTransaction(scopedDb, {
      accountId: input.organizationId,
      reason: "organization_codex_credential_connected",
      restoreWorkspaceId: null,
    });
    return {
      id: row.id,
      isNew: row.createdAt.getTime() === row.updatedAt.getTime(),
      wakeTargets,
    };
  });
}

export async function listOrganizationCodexAccountStatuses(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<CodexAccountStatus[]> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const [rotation] = await scopedDb
      .select({ activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .limit(1);
    const rows = await scopedDb
      .select({
        id: schema.codexSubscriptionCredentials.id,
        chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
        allowedModelIds: schema.codexSubscriptionCredentials.allowedModelIds,
        label: schema.codexSubscriptionCredentials.label,
        accountEmail: schema.codexSubscriptionCredentials.accountEmail,
        planType: schema.codexSubscriptionCredentials.planType,
        status: schema.codexSubscriptionCredentials.status,
        extraCreditsEnabled: schema.codexSubscriptionCredentials.extraCreditsEnabled,
        extraCreditsVersion: schema.codexSubscriptionCredentials.extraCreditsVersion,
        extraCreditsUpdatedAt: schema.codexSubscriptionCredentials.extraCreditsUpdatedAt,
        includedUsageUnavailableUntil:
          schema.codexSubscriptionCredentials.includedUsageUnavailableUntil,
        allocatorEnabled: schema.codexSubscriptionCredentials.allocatorEnabled,
        allocatorVersion: schema.codexSubscriptionCredentials.allocatorVersion,
        allocatorUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.allocatorUpdatedBySubjectId,
        allocatorUpdatedAt: schema.codexSubscriptionCredentials.allocatorUpdatedAt,
        resetCreditAvailableCount: schema.codexSubscriptionCredentials.resetCreditAvailableCount,
        resetCreditsCheckedAt: schema.codexSubscriptionCredentials.resetCreditsCheckedAt,
        connectedBySubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
        expiresAt: schema.codexSubscriptionCredentials.expiresAt,
        lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
        lastError: schema.codexSubscriptionCredentials.lastError,
        primaryUsedPercent: schema.codexSubscriptionCredentials.primaryUsedPercent,
        primaryResetAt: schema.codexSubscriptionCredentials.primaryResetAt,
        secondaryUsedPercent: schema.codexSubscriptionCredentials.secondaryUsedPercent,
        secondaryResetAt: schema.codexSubscriptionCredentials.secondaryResetAt,
        usageCheckedAt: schema.codexSubscriptionCredentials.usageCheckedAt,
        exhaustedUntil: schema.codexSubscriptionCredentials.exhaustedUntil,
        exhaustedKind: schema.codexSubscriptionCredentials.exhaustedKind,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.accountId, input.organizationId),
          eq(schema.codexSubscriptionCredentials.organizationId, input.organizationId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        ),
      )
      .orderBy(
        asc(schema.codexSubscriptionCredentials.createdAt),
        asc(schema.codexSubscriptionCredentials.id),
      );
    return rows.map((row) => ({
      ...row,
      source: "organization" as const,
      isActive: row.id === rotation?.activeCredentialId,
      expiresAt: codexMetadataDate(row.expiresAt),
      lastRefreshAt: codexMetadataDate(row.lastRefreshAt),
      extraCreditsUpdatedAt: codexMetadataDate(row.extraCreditsUpdatedAt),
      includedUsageUnavailableUntil: codexMetadataDate(row.includedUsageUnavailableUntil),
      allocatorUpdatedAt: codexMetadataDate(row.allocatorUpdatedAt),
      resetCreditsCheckedAt: codexMetadataDate(row.resetCreditsCheckedAt),
      primaryResetAt: codexMetadataDate(row.primaryResetAt),
      secondaryResetAt: codexMetadataDate(row.secondaryResetAt),
      usageCheckedAt: codexMetadataDate(row.usageCheckedAt),
      exhaustedUntil: codexMetadataDate(row.exhaustedUntil),
      exhaustedKind:
        row.exhaustedKind === "quota" || row.exhaustedKind === "rate_limit"
          ? row.exhaustedKind
          : null,
    }));
  });
}

export async function getOrganizationCodexRotationSettings(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<CodexRotationSettings | null> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
        rotationEnabled: schema.organizationCodexRotationSettings.rotationEnabled,
        rotationStrategy: schema.organizationCodexRotationSettings.rotationStrategy,
      })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .limit(1);
    return row ?? null;
  });
}

export async function setActiveOrganizationCodexCredential(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; credentialId: string },
): Promise<{ activated: boolean; wakeTargets: CodexCapacityWakeTarget[] }> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const [settings] = await scopedDb
      .select({
        id: schema.organizationCodexRotationSettings.id,
        activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
      })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .for("update")
      .limit(1);
    if (!settings) return { activated: false, wakeTargets: [] };
    const [credential] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          eq(schema.codexSubscriptionCredentials.organizationId, input.organizationId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        ),
      )
      .limit(1);
    if (!credential) return { activated: false, wakeTargets: [] };
    const updated = await scopedDb
      .update(schema.organizationCodexRotationSettings)
      .set({ activeCredentialId: input.credentialId, updatedAt: new Date() })
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .returning({ id: schema.organizationCodexRotationSettings.id });
    if (updated.length === 0) return { activated: false, wakeTargets: [] };
    const wakeTargets =
      settings.activeCredentialId === input.credentialId
        ? []
        : await wakeOrganizationCodexCapacityWaitersInTransaction(scopedDb, {
            accountId: input.organizationId,
            reason: "organization_codex_active_credential_changed",
            restoreWorkspaceId: null,
          });
    return { activated: true, wakeTargets };
  });
}

export async function updateOrganizationCodexRotationSettings(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    rotationEnabled: boolean;
  },
): Promise<(CodexRotationSettings & { wakeTargets: CodexCapacityWakeTarget[] }) | null> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const [current] = await scopedDb
      .select({
        rotationEnabled: schema.organizationCodexRotationSettings.rotationEnabled,
      })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .for("update")
      .limit(1);
    if (!current) return null;
    const [row] = await scopedDb
      .update(schema.organizationCodexRotationSettings)
      .set({
        rotationEnabled: input.rotationEnabled,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .returning({
        activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
        rotationEnabled: schema.organizationCodexRotationSettings.rotationEnabled,
        rotationStrategy: schema.organizationCodexRotationSettings.rotationStrategy,
      });
    if (!row) return null;
    const changed = current.rotationEnabled !== input.rotationEnabled;
    const wakeTargets = changed
      ? await wakeOrganizationCodexCapacityWaitersInTransaction(scopedDb, {
          accountId: input.organizationId,
          reason: "organization_codex_rotation_settings_changed",
          restoreWorkspaceId: null,
        })
      : [];
    return { ...row, wakeTargets };
  });
}

export async function renameOrganizationCodexAccount(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    credentialId: string;
    label: string | null;
  },
): Promise<boolean> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ label: input.label, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          eq(schema.codexSubscriptionCredentials.organizationId, input.organizationId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

export async function disconnectOrganizationCodexAccount(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; credentialId: string },
): Promise<{
  removed: boolean;
  newActiveCredentialId: string | null;
  wakeTargets: CodexCapacityWakeTarget[];
}> {
  return await withOrganizationCodexAdministrator(db, input, async (scopedDb) => {
    const organizationWorkspaceIds = await lockOrganizationCodexSubscriptionSources(
      scopedDb,
      input.organizationId,
    );
    await captureOrganizationCodexSubscriptionSources(
      scopedDb,
      input.organizationId,
      organizationWorkspaceIds,
    );
    const [settings] = await scopedDb
      .select({ activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId })
      .from(schema.organizationCodexRotationSettings)
      .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId))
      .for("update")
      .limit(1);
    const removed = await scopedDb
      .delete(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          eq(schema.codexSubscriptionCredentials.organizationId, input.organizationId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    if (removed.length === 0) {
      return {
        removed: false,
        newActiveCredentialId: settings?.activeCredentialId ?? null,
        wakeTargets: [],
      };
    }
    let newActiveCredentialId = settings?.activeCredentialId ?? null;
    if (newActiveCredentialId === input.credentialId) {
      const [replacement] = await scopedDb
        .select({ id: schema.codexSubscriptionCredentials.id })
        .from(schema.codexSubscriptionCredentials)
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.organizationId, input.organizationId),
            eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
          ),
        )
        .orderBy(desc(schema.codexSubscriptionCredentials.createdAt))
        .limit(1);
      newActiveCredentialId = replacement?.id ?? null;
      await scopedDb
        .update(schema.organizationCodexRotationSettings)
        .set({ activeCredentialId: newActiveCredentialId, updatedAt: new Date() })
        .where(eq(schema.organizationCodexRotationSettings.accountId, input.organizationId));
    }
    const wakeTargets = await wakeOrganizationCodexCapacityWaitersInTransaction(scopedDb, {
      accountId: input.organizationId,
      reason: "organization_codex_credential_disconnected",
      restoreWorkspaceId: null,
    });
    return { removed: true, newActiveCredentialId, wakeTargets };
  });
}

export async function getCodexAppsSettings(
  db: Database,
  workspaceId: string,
): Promise<CodexAppsSettings> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        credentialId: schema.codexAppsSettings.credentialId,
        version: schema.codexAppsSettings.version,
        designatedAt: schema.codexAppsSettings.designatedAt,
      })
      .from(schema.codexAppsSettings)
      .where(eq(schema.codexAppsSettings.workspaceId, workspaceId))
      .limit(1);
    return row ?? { credentialId: null, version: 0, designatedAt: null };
  });
}

function canManageCodexApps(permissions: unknown): boolean {
  return (
    Array.isArray(permissions) &&
    (permissions.includes("connections:write") || permissions.includes("workspace:admin"))
  );
}

export async function getCodexAppsCredentialAuthorizationForRun(
  db: Database,
  workspaceId: string,
): Promise<CodexAppsCredentialAuthorization | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        credentialId: schema.codexAppsSettings.credentialId,
        ownerSubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
      })
      .from(schema.codexAppsSettings)
      .innerJoin(
        schema.codexSubscriptionCredentials,
        and(
          eq(schema.codexSubscriptionCredentials.id, schema.codexAppsSettings.credentialId),
          eq(schema.codexSubscriptionCredentials.accountId, schema.codexAppsSettings.accountId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          eq(schema.codexSubscriptionCredentials.status, "active"),
        ),
      )
      .where(eq(schema.codexAppsSettings.workspaceId, workspaceId))
      .limit(1);
    return row?.credentialId && row.ownerSubjectId
      ? { credentialId: row.credentialId, ownerSubjectId: row.ownerSubjectId }
      : null;
  });
}

export async function withCodexAppsRequestAuthorization<T>(
  db: Database,
  input: { workspaceId: string; credentialId: string },
  use: () => Promise<T>,
): Promise<T> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${input.workspaceId}`}, 0))`,
    );
    const [designation] = await scopedDb
      .select({ credentialId: schema.codexAppsSettings.credentialId })
      .from(schema.codexAppsSettings)
      .where(eq(schema.codexAppsSettings.workspaceId, input.workspaceId))
      .for("share")
      .limit(1);
    if (designation?.credentialId !== input.credentialId) {
      throw new CodexAppsAuthorizationRevokedError();
    }
    const [credential] = await scopedDb
      .select({
        ownerSubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
        status: schema.codexSubscriptionCredentials.status,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .for("share")
      .limit(1);
    if (!credential?.ownerSubjectId) {
      throw new CodexAppsAuthorizationRevokedError();
    }
    const [membership] = await scopedDb
      .select({ permissions: schema.workspaceMemberships.permissions })
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, input.workspaceId),
          eq(schema.workspaceMemberships.subjectId, credential.ownerSubjectId),
        ),
      )
      .for("share")
      .limit(1);
    if (!canManageCodexApps(membership?.permissions)) {
      throw new CodexAppsAuthorizationRevokedError();
    }
    if (credential.status !== "active") {
      // Still the authorized designation, but its sign-in must be renewed.
      throw new CodexReloginRequired("The designated Codex Apps account must be reconnected.");
    }
    return await use();
  });
}

export async function designateCodexAppsCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    credentialId: string;
    subjectId: string;
    expectedVersion: number;
  },
): Promise<DesignateCodexAppsCredentialResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${input.workspaceId}`}, 0))`,
      );
      const [currentRow] = await scopedDb
        .select()
        .from(schema.codexAppsSettings)
        .where(eq(schema.codexAppsSettings.workspaceId, input.workspaceId))
        .for("update")
        .limit(1);
      const current: CodexAppsSettings = currentRow
        ? {
            credentialId: currentRow.credentialId,
            version: currentRow.version,
            designatedAt: currentRow.designatedAt,
          }
        : { credentialId: null, version: 0, designatedAt: null };
      if (current.version !== input.expectedVersion) return { kind: "conflict", ...current };
      if (current.credentialId !== null) return { kind: "already_designated", ...current };

      const [credential] = await scopedDb
        .select({
          connectedBySubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
          status: schema.codexSubscriptionCredentials.status,
        })
        .from(schema.codexSubscriptionCredentials)
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
            eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
            eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          ),
        )
        .for("update")
        .limit(1);
      if (!credential) return { kind: "not_found" };
      if (credential.connectedBySubjectId !== input.subjectId) return { kind: "not_owner" };
      if (credential.status !== "active") return { kind: "unavailable" };

      const [membership] = await scopedDb
        .select({ permissions: schema.workspaceMemberships.permissions })
        .from(schema.workspaceMemberships)
        .where(
          and(
            eq(schema.workspaceMemberships.accountId, input.accountId),
            eq(schema.workspaceMemberships.workspaceId, input.workspaceId),
            eq(schema.workspaceMemberships.subjectId, input.subjectId),
          ),
        )
        .for("update")
        .limit(1);
      if (!canManageCodexApps(membership?.permissions)) return { kind: "forbidden" };

      const now = new Date();
      const version = current.version + 1;
      const [updated] = await scopedDb
        .insert(schema.codexAppsSettings)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialId: input.credentialId,
          version,
          designatedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.codexAppsSettings.workspaceId,
          set: {
            credentialId: input.credentialId,
            version,
            designatedAt: now,
            updatedAt: now,
          },
        })
        .returning({
          credentialId: schema.codexAppsSettings.credentialId,
          version: schema.codexAppsSettings.version,
          designatedAt: schema.codexAppsSettings.designatedAt,
        });
      if (!updated?.credentialId || !updated.designatedAt) {
        throw new Error("Codex Apps designation was not persisted");
      }
      await scopedDb.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            action: "codex_apps.designated",
            targetType: "codex_subscription_credential",
            targetId: input.credentialId,
            metadata: { version },
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
      return { kind: "updated", ...updated };
    },
  );
}

export async function clearCodexAppsCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    expectedVersion: number;
  },
): Promise<ClearCodexAppsCredentialResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${input.workspaceId}`}, 0))`,
      );
      const [row] = await scopedDb
        .select()
        .from(schema.codexAppsSettings)
        .where(eq(schema.codexAppsSettings.workspaceId, input.workspaceId))
        .for("update")
        .limit(1);
      const current: CodexAppsSettings = row
        ? {
            credentialId: row.credentialId,
            version: row.version,
            designatedAt: row.designatedAt,
          }
        : { credentialId: null, version: 0, designatedAt: null };
      const [membership] = await scopedDb
        .select({ permissions: schema.workspaceMemberships.permissions })
        .from(schema.workspaceMemberships)
        .where(
          and(
            eq(schema.workspaceMemberships.accountId, input.accountId),
            eq(schema.workspaceMemberships.workspaceId, input.workspaceId),
            eq(schema.workspaceMemberships.subjectId, input.subjectId),
          ),
        )
        .for("update")
        .limit(1);
      if (!canManageCodexApps(membership?.permissions)) {
        return { kind: "forbidden", ...current };
      }
      if (current.version !== input.expectedVersion) return { kind: "conflict", ...current };
      if (current.credentialId === null) return { kind: "unchanged", ...current };

      const now = new Date();
      const version = current.version + 1;
      const [updated] = await scopedDb
        .update(schema.codexAppsSettings)
        .set({
          credentialId: null,
          version,
          designatedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.codexAppsSettings.workspaceId, input.workspaceId))
        .returning({
          credentialId: schema.codexAppsSettings.credentialId,
          version: schema.codexAppsSettings.version,
          designatedAt: schema.codexAppsSettings.designatedAt,
        });
      if (!updated) throw new Error("Codex Apps designation clear was not persisted");
      await scopedDb.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            action: "codex_apps.cleared",
            targetType: "codex_subscription_credential",
            targetId: current.credentialId,
            metadata: { version },
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
      return { kind: "updated", ...updated };
    },
  );
}

type CodexAcceptedCredentialAuthority =
  | CodexAcceptedLeaseAuthority
  | {
      turnId: string;
      purpose: "capacity_refresh";
    };

type CodexAppsCredentialUseAuthority = { purpose: "codex_apps" };

const CODEX_APPS_REFRESH_OUTCOME_BRAND: unique symbol = Symbol("codex_apps_refresh_outcome");

type CodexAppsRefreshOutcomeAuthority = {
  readonly purpose: "codex_apps_refresh_outcome";
  readonly [CODEX_APPS_REFRESH_OUTCOME_BRAND]: true;
};

type CodexCredentialUseAuthority =
  | CodexAcceptedCredentialAuthority
  | CodexAppsCredentialUseAuthority
  | CodexAppsRefreshOutcomeAuthority;

const CODEX_APPS_CREDENTIAL_USE: CodexAppsCredentialUseAuthority = { purpose: "codex_apps" };

const CODEX_APPS_REFRESH_OUTCOME: CodexAppsRefreshOutcomeAuthority = {
  purpose: "codex_apps_refresh_outcome",
  [CODEX_APPS_REFRESH_OUTCOME_BRAND]: true,
};

function codexAppsCredentialUseCondition(workspaceId: string): SQL {
  return and(
    eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
    inArray(schema.codexSubscriptionCredentials.authorityScope, ["workspace", "user"]),
    sql`exists (
      select 1 from codex_apps_settings apps
      join workspace_memberships apps_owner
        on apps_owner.account_id = apps.account_id
       and apps_owner.workspace_id = apps.workspace_id
       and apps_owner.subject_id = ${schema.codexSubscriptionCredentials.connectedBySubjectId}
      where apps.workspace_id = ${workspaceId}
        and apps.account_id = ${schema.codexSubscriptionCredentials.accountId}
        and apps.credential_id = ${schema.codexSubscriptionCredentials.id}
        and (
          apps_owner.permissions @> '["connections:write"]'::jsonb
          or apps_owner.permissions @> '["workspace:admin"]'::jsonb
        )
    )`,
  )!;
}

async function codexCredentialUseCondition(
  tx: Database,
  workspaceId: string,
  authority?: CodexCredentialUseAuthority,
): Promise<SQL | null> {
  if (!authority) return (await effectiveCodexCredentialPoolCondition(tx, workspaceId)).condition;
  if ("purpose" in authority) {
    if (authority.purpose === "codex_apps") return codexAppsCredentialUseCondition(workspaceId);
    if (authority.purpose === "codex_apps_refresh_outcome") {
      if (authority !== CODEX_APPS_REFRESH_OUTCOME) {
        throw new Error("Codex Apps refresh-outcome authority is internal to the Apps resolver");
      }
      // Same workspace-owned row family the designation can name; the caller's
      // id + version CAS pins the exact row loaded under the designation.
      return and(
        eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        inArray(schema.codexSubscriptionCredentials.authorityScope, ["workspace", "user"]),
      )!;
    }
    return sql`opengeni_private.codex_credential_serves_turn(
      ${schema.codexSubscriptionCredentials.accountId}, ${workspaceId}::uuid,
      ${schema.codexSubscriptionCredentials.id}, ${authority.turnId}::uuid)`;
  }
  return sql`exists (
    select 1 from codex_credential_leases lease
    join session_turns accepted on accepted.id = lease.turn_id
      and accepted.workspace_id = lease.workspace_id and accepted.account_id = lease.account_id
    join sessions session on session.id = accepted.session_id
      and session.workspace_id = accepted.workspace_id and session.account_id = accepted.account_id
      and session.active_turn_id = accepted.id
    where lease.workspace_id = ${workspaceId}
      and lease.credential_id = ${schema.codexSubscriptionCredentials.id}
      and lease.turn_id = ${authority.turnId} and lease.holder_id = ${authority.holderId}
      and lease.generation = ${authority.generation}
      and lease.leased_until > clock_timestamp()
      and accepted.status = 'running' and accepted.active_attempt_id is not null
      and opengeni_private.codex_credential_serves_turn(
        lease.account_id, lease.workspace_id, lease.credential_id, lease.turn_id)
  )`;
}

export async function loadCodexCredentialForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  // Refresh-outcome authority only records a result; it can never load a row.
  authority?: Exclude<CodexCredentialUseAuthority, CodexAppsRefreshOutcomeAuthority>,
): Promise<CodexCredentialForRun | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const condition = await codexCredentialUseCondition(scopedDb, workspaceId, authority);
    if (!condition) return null;
    const [row] = await scopedDb
      .select()
      .from(schema.codexSubscriptionCredentials)
      .where(and(eq(schema.codexSubscriptionCredentials.id, credentialId), condition))
      .limit(1);
    if (!row) {
      return null;
    }
    let tokens: CodexCredentialTokens;
    try {
      // The stored blob uses OpenAI's snake_case token field names; map to the
      // camelCase internal shape. Callers (route + worker) write snake_case.
      const parsed = JSON.parse(decryptEnvironmentValue(key, row.credentialEncrypted)) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      tokens = {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        idToken: parsed.id_token,
      };
    } catch {
      // Fixed text and no cause: a JSON.parse message quotes the plaintext
      // token it failed on, and runtimes print a cause with the error.
      throw new Error(`failed to decrypt codex credential for workspace ${workspaceId}`);
    }
    return {
      id: row.id,
      version: row.version,
      workspaceId,
      tokens,
      chatgptAccountId: row.chatgptAccountId,
      scopes: row.scopes,
      planType: row.planType,
      planPreviousType: row.planPreviousType,
      planChangedAt: row.planChangedAt,
      planEntitlementExclusion: readCodexPlanEntitlementExclusion(row.planEntitlementExclusion),
      isFedramp: row.isFedramp,
      expiresAt: row.expiresAt,
      lastRefreshAt: row.lastRefreshAt,
      status: row.status,
      lastError: row.lastError,
      exhaustedUntil: row.exhaustedUntil,
      exhaustedKind:
        row.exhaustedKind === "quota" || row.exhaustedKind === "rate_limit"
          ? row.exhaustedKind
          : null,
      exhaustedRevision: row.exhaustedRevision,
    };
  });
}

function codexPlanObservationSet(planType: string, observedAt: Date) {
  return {
    planType,
    planCheckedAt: observedAt,
    ...codexPlanChangeRecordSet(planType, observedAt),
    planEntitlementExclusion: sql`case
      when lower(${schema.codexSubscriptionCredentials.planType}) is distinct from lower(${planType})
        then null
      else ${schema.codexSubscriptionCredentials.planEntitlementExclusion}
    end`,
  };
}

function codexPlanChangeRecordSet(planType: string, observedAt: Date) {
  const changed = sql`${schema.codexSubscriptionCredentials.planType} is not null
      and lower(${schema.codexSubscriptionCredentials.planType}) is distinct from lower(${planType})`;
  return {
    planPreviousType: sql`case when ${changed}
      then left(${schema.codexSubscriptionCredentials.planType}, 128)
      else ${schema.codexSubscriptionCredentials.planPreviousType}
    end`,
    planChangedAt: sql`case when ${changed}
      then ${observedAt.toISOString()}::timestamptz
      else ${schema.codexSubscriptionCredentials.planChangedAt}
    end`,
  };
}

export async function recordCodexTokenRefresh(
  db: Database,
  input: {
    id: string;
    version: number;
    workspaceId: string;
    credentialEncrypted: string;
    expiresAt: Date | null;
    lastRefreshAt: Date;
    /**
     * `chatgpt_plan_type` from the refreshed id_token, when the provider
     * returned one. A changed plan retires any plan entitlement exclusion.
     */
    planType?: string | null | undefined;
    authority?: CodexCredentialUseAuthority | undefined;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const condition = await codexCredentialUseCondition(
      scopedDb,
      input.workspaceId,
      input.authority,
    );
    if (!condition) return false;
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({
        credentialEncrypted: input.credentialEncrypted,
        expiresAt: input.expiresAt,
        lastRefreshAt: input.lastRefreshAt,
        ...(typeof input.planType === "string" && input.planType.length > 0
          ? codexPlanObservationSet(input.planType, input.lastRefreshAt)
          : {}),
        status: "active",
        lastError: null,
        version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, input.id),
          condition,
          eq(schema.codexSubscriptionCredentials.version, input.version),
          eq(schema.codexSubscriptionCredentials.status, "active"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

export async function withCodexCredentialRefreshLock<T>(
  db: Database,
  workspaceId: string,
  credentialId: string,
  fn: (lockedDb: Database) => Promise<T>,
): Promise<T> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`set local lock_timeout = '30s'`);
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`codex-refresh:${credentialId}`}, 0))`,
    );
    return await fn(scopedDb);
  });
}

export async function setCodexCredentialStatus(
  db: Database,
  workspaceId: string,
  status: "active" | "needs_relogin" | "error",
  lastError: string | null,
  target: { id: string; version: number },
  authority?: CodexCredentialUseAuthority,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const condition = await codexCredentialUseCondition(scopedDb, workspaceId, authority);
    if (!condition) return false;
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ status, lastError, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, target.id),
          condition,
          eq(schema.codexSubscriptionCredentials.version, target.version),
          eq(schema.codexSubscriptionCredentials.status, "active"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

export async function setCodexCredentialStatusById(
  db: Database,
  workspaceId: string,
  credentialId: string,
  status: "active" | "needs_relogin" | "error",
  lastError: string | null,
): Promise<boolean> {
  const mutation = await withCodexCapacityMutation(
    db,
    { workspaceId, reason: "credential_status_changed", mutationSource: "effective" },
    async (scopedDb) => {
      const pool = await effectiveCodexCredentialPoolCondition(scopedDb, workspaceId);
      if (!pool.condition) return { result: false, changed: false };
      const [row] = await scopedDb
        .select({
          version: schema.codexSubscriptionCredentials.version,
          status: schema.codexSubscriptionCredentials.status,
        })
        .from(schema.codexSubscriptionCredentials)
        .where(and(eq(schema.codexSubscriptionCredentials.id, credentialId), pool.condition))
        .limit(1);
      if (!row) {
        return { result: false, changed: false };
      }
      const updated = await scopedDb
        .update(schema.codexSubscriptionCredentials)
        .set({
          status,
          lastError,
          updatedAt: new Date(),
          // Explicit reactivation is a new credential-health generation. A
          // same-turn status refusal can recover only after this or reconnect.
          ...(status === "active" && row.status !== "active" ? { version: row.version + 1 } : {}),
        })
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.id, credentialId),
            pool.condition,
            eq(schema.codexSubscriptionCredentials.version, row.version),
            eq(schema.codexSubscriptionCredentials.status, row.status),
          ),
        )
        .returning({ id: schema.codexSubscriptionCredentials.id });
      return { result: updated.length > 0, changed: updated.length > 0 };
    },
  );
  return mutation.result;
}

async function getCodexCredentialStatusScoped(
  scopedDb: Database,
  workspaceId: string,
): Promise<CodexCredentialStatus | null> {
  const pool = await effectiveCodexCredentialPoolCondition(scopedDb, workspaceId);
  if (!pool.condition || pool.source.effectiveSource === "disabled") return null;
  const cols = {
    id: schema.codexSubscriptionCredentials.id,
    chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
    scopes: schema.codexSubscriptionCredentials.scopes,
    planType: schema.codexSubscriptionCredentials.planType,
    status: schema.codexSubscriptionCredentials.status,
    expiresAt: schema.codexSubscriptionCredentials.expiresAt,
    lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
    lastError: schema.codexSubscriptionCredentials.lastError,
  } as const;
  const organizationSource = pool.source.effectiveSource === "organization";
  const [settingsRow] = organizationSource
    ? await scopedDb
        .select({
          activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
        })
        .from(schema.organizationCodexRotationSettings)
        .where(eq(schema.organizationCodexRotationSettings.accountId, pool.source.accountId))
        .for("update")
        .limit(1)
    : await scopedDb
        .select({
          activeCredentialId: schema.codexRotationSettings.activeCredentialId,
        })
        .from(schema.codexRotationSettings)
        .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
        .for("update")
        .limit(1);

  let row:
    | {
        id: string;
        chatgptAccountId: string | null;
        scopes: string | null;
        planType: string | null;
        status: string;
        expiresAt: Date | null;
        lastRefreshAt: Date | null;
        lastError: string | null;
      }
    | undefined;
  if (settingsRow?.activeCredentialId) {
    [row] = await scopedDb
      .select(cols)
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, settingsRow.activeCredentialId),
          pool.condition,
        ),
      )
      .limit(1);
  }
  if (!row) {
    // No active pointer (or it dangles): fall back to the most-recently-connected
    // credential and lazily repair the pointer so the active account is stable.
    [row] = await scopedDb
      .select(cols)
      .from(schema.codexSubscriptionCredentials)
      .where(
        organizationSource
          ? and(
              pool.condition,
              eq(schema.codexSubscriptionCredentials.status, "active"),
              eq(schema.codexSubscriptionCredentials.allocatorEnabled, true),
            )
          : pool.condition,
      )
      .orderBy(
        organizationSource
          ? asc(schema.codexSubscriptionCredentials.createdAt)
          : desc(schema.codexSubscriptionCredentials.createdAt),
        asc(schema.codexSubscriptionCredentials.id),
      )
      .limit(1);
    // An organization default can be deliberately unassigned here. A local
    // readiness read must never rewrite that organization's default.
    if (row && settingsRow && !organizationSource && settingsRow.activeCredentialId !== row.id) {
      await scopedDb
        .update(schema.codexRotationSettings)
        .set({ activeCredentialId: row.id, updatedAt: new Date() })
        .where(eq(schema.codexRotationSettings.workspaceId, workspaceId));
    }
  }
  if (!row) {
    return null;
  }
  const { id, ...rest } = row;
  return { connected: rest.status === "active", credentialId: id, ...rest };
}

export async function getCodexCredentialStatus(
  db: Database,
  workspaceId: string,
): Promise<CodexCredentialStatus | null> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) => await getCodexCredentialStatusScoped(scopedDb, workspaceId),
  );
}

export async function legacyWorkspaceCodexSubscriptionActive(
  db: Database,
  settings: Pick<Settings, "codexSubscriptionEnabled">,
  workspaceId: string,
  acceptedTurnId?: string,
): Promise<boolean> {
  if (!settings.codexSubscriptionEnabled) {
    return false;
  }
  return await withCodexActiveReadRetry(
    async () => await readLegacyWorkspaceCodexSubscriptionActive(db, workspaceId, acceptedTurnId),
  );
}

async function readLegacyWorkspaceCodexSubscriptionActive(
  db: Database,
  workspaceId: string,
  acceptedTurnId: string | undefined,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const pool = await effectiveCodexCredentialPoolCondition(scopedDb, workspaceId);
    if (acceptedTurnId) {
      const acceptedSource = await codexSourceForTurn(
        scopedDb,
        workspaceId,
        acceptedTurnId,
        pool.source.effectiveSource,
      );
      pool.source.effectiveSource = acceptedSource;
      pool.condition =
        acceptedSource === "disabled"
          ? null
          : codexCredentialPoolCondition({
              accountId: pool.source.accountId,
              workspaceId,
              source: acceptedSource,
            });
    }
    if (!pool.condition || pool.source.effectiveSource === "disabled") return false;
    // Provider admission is pool-aware even when rotation is disabled. The
    // active pointer governs allocation policy, not whether the connected
    // subscription provider exists for billing and routing.
    const [row] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(and(pool.condition, eq(schema.codexSubscriptionCredentials.status, "active")))
      .limit(1);
    return Boolean(row);
  });
}

async function withCodexActiveReadRetry(read: () => Promise<boolean>): Promise<boolean> {
  // Bounded re-read. A TRANSIENT read failure (a pooled-connection blip or a
  // lost RLS GUC — now thrown loud by withRlsContext's read-back guard rather
  // than silently returning zero rows) must never permanently decide a
  // genuinely-active subscription is disconnected, which would throw the
  // fail-loud CodexSubscriptionUnavailableError at model resolution and fail the
  // turn. Retry only on a THROWN error (the transient signature); a cleanly
  // returned status — a row (any status) or a confirmed absent row (null) — is
  // authoritative and resolves immediately, so the common no-subscription turn
  // pays no extra latency.
  let lastError: unknown;
  for (let attempt = 0; attempt < CODEX_ACTIVE_READ_ATTEMPTS; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt < CODEX_ACTIVE_READ_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CODEX_ACTIVE_READ_RETRY_MS * (attempt + 1)),
        );
      }
    }
  }
  // Every attempt threw: this is a real, persistent read outage, not a one-off
  // blip. Surface the underlying error (truthful + retryable) instead of
  // silently denying an active subscription.
  console.error("workspace Codex subscription credential read failed after retries", {
    errorClass: "CredentialReadOperationError",
    errorCode: "codex_active_credential_read_failed",
    origin: "db",
  });
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const CODEX_ACTIVE_READ_ATTEMPTS = 3;

const CODEX_ACTIVE_READ_RETRY_MS = 50;

function codexFailoverMetadata(metadata: Record<string, unknown> | null | undefined): {
  failedCredentialIds: Set<string>;
  failoverCount: number;
  maxFailovers: number | null;
  exhausted: boolean;
} {
  const failedCredentialIds = new Set(
    Array.isArray(metadata?.codexCredentialFailedIds)
      ? metadata.codexCredentialFailedIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [],
  );
  const rawCount = metadata?.codexCredentialFailovers;
  const failoverCount =
    typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0
      ? rawCount
      : failedCredentialIds.size;
  const rawLimit = metadata?.codexCredentialFailoverLimit;
  const maxFailovers =
    typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit >= 1
      ? rawLimit
      : null;
  return {
    failedCredentialIds,
    failoverCount,
    maxFailovers,
    exhausted:
      metadata?.codexCredentialFailoverExhausted === true ||
      (maxFailovers !== null && failoverCount > maxFailovers),
  };
}

function codexCredentialFailoverLimitForLease(
  accounts: readonly CodexLeaseAccountStatus[],
  servingCredentialId: string | null,
): number {
  const allocatableCount = accounts.filter((account) => account.allocatorEnabled).length;
  const servingIsAllocatable = accounts.some(
    (account) => account.id === servingCredentialId && account.allocatorEnabled,
  );
  return Math.max(1, allocatableCount - (servingIsAllocatable ? 1 : 0));
}

type CodexLeaseCandidateRow = {
  allowed_model_ids: string[] | null;
  id: string;
  chatgpt_account_id: string | null;
  label: string | null;
  account_email: string | null;
  plan_type: string | null;
  plan_checked_at?: Date | string | null;
  plan_entitlement_exclusion?: unknown;
  status: string;
  extra_credits_enabled?: boolean;
  included_usage_unavailable_until?: Date | string | null;
  allocator_enabled: boolean;
  expires_at: Date | string | null;
  last_refresh_at: Date | string | null;
  last_error: string | null;
  primary_used_percent: number | null;
  primary_reset_at: Date | string | null;
  secondary_used_percent: number | null;
  secondary_reset_at: Date | string | null;
  usage_checked_at: Date | string | null;
  exhausted_until: Date | string | null;
  exhausted_kind: string | null;
  exhausted_revision?: number | string | null;
  credential_version?: number | string | null;
  selection_count: number;
  last_selected_at: Date | string | null;
  active_lease_count: number;
};

function codexMetadataDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapCodexLeaseCandidate(
  row: CodexLeaseCandidateRow,
  activeCredentialId: string | null,
): CodexLeaseAccountStatus {
  return {
    id: row.id,
    chatgptAccountId: row.chatgpt_account_id,
    allowedModelIds: row.allowed_model_ids,
    label: row.label,
    accountEmail: row.account_email,
    planType: row.plan_type,
    planCheckedAt: codexMetadataDate(row.plan_checked_at),
    planEntitlementExclusion: readCodexPlanEntitlementExclusion(row.plan_entitlement_exclusion),
    status: row.status,
    extraCreditsEnabled: row.extra_credits_enabled === true,
    includedUsageUnavailableUntil: codexMetadataDate(row.included_usage_unavailable_until),
    allocatorEnabled: row.allocator_enabled,
    isActive: row.id === activeCredentialId,
    expiresAt: codexMetadataDate(row.expires_at),
    lastRefreshAt: codexMetadataDate(row.last_refresh_at),
    lastError: row.last_error,
    primaryUsedPercent: row.primary_used_percent,
    primaryResetAt: codexMetadataDate(row.primary_reset_at),
    secondaryUsedPercent: row.secondary_used_percent,
    secondaryResetAt: codexMetadataDate(row.secondary_reset_at),
    usageCheckedAt: codexMetadataDate(row.usage_checked_at),
    exhaustedUntil: codexMetadataDate(row.exhausted_until),
    exhaustedRevision: Number(row.exhausted_revision ?? 0),
    credentialVersion: Number(row.credential_version ?? 0),
    exhaustedKind:
      row.exhausted_kind === "quota" || row.exhausted_kind === "rate_limit"
        ? row.exhausted_kind
        : null,
    selectionCount: Number(row.selection_count),
    lastSelectedAt: codexMetadataDate(row.last_selected_at),
    activeLeaseCount: Number(row.active_lease_count),
  };
}

function filterCodexLeaseCandidatesForPolicy<TPolicyScope, TUnavailableDiagnostic>(
  accounts: CodexLeaseAccountStatus[],
  policyScope: TPolicyScope | null,
  filter: CodexCredentialLeaseCandidateFilter<TPolicyScope, TUnavailableDiagnostic> | undefined,
): {
  accounts: CodexLeaseAccountStatus[];
  unavailableDiagnostics: readonly TUnavailableDiagnostic[];
} {
  const filtered = filter?.({ accounts, policyScope });
  if (!filtered) return { accounts, unavailableDiagnostics: [] };
  const structured = Array.isArray(filtered)
    ? null
    : (filtered as CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic>);
  const filteredAccounts = structured?.accounts ?? (filtered as readonly CodexLeaseAccountStatus[]);
  const unavailableDiagnostics = structured?.unavailableDiagnostics ?? [];
  const workspaceIds = new Set(accounts.map((account) => account.id));
  const filteredIds = new Set<string>();
  for (const account of filteredAccounts) {
    if (!workspaceIds.has(account.id) || filteredIds.has(account.id)) {
      throw new Error("Codex lease candidate filter returned a foreign or duplicate credential");
    }
    filteredIds.add(account.id);
  }
  return { accounts: [...filteredAccounts], unavailableDiagnostics };
}

async function listCodexLeaseCandidatesInTransaction(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    activeCredentialId: string | null;
    source: Exclude<EffectiveCodexSubscriptionSource, "disabled">;
    excludeTurnId?: string | null;
  },
): Promise<CodexLeaseAccountStatus[]> {
  const legacyWorkspaceOnly =
    input.source === "workspace" &&
    workspaceCodexOrganizationInheritanceAvailable.get(input.workspaceId) === false;
  const rows = await tx.execute(sql<CodexLeaseCandidateRow>`
    select
      c.id,
      c.chatgpt_account_id,
      c.version as credential_version,
      c.allowed_model_ids,
      c.label,
      c.account_email,
      c.plan_type,
      c.status,
      c.allocator_enabled,
      coalesce((to_jsonb(c) ->> 'extra_credits_enabled')::boolean, false) as extra_credits_enabled,
      to_jsonb(c) ->> 'included_usage_unavailable_until' as included_usage_unavailable_until,
      c.expires_at,
      c.last_refresh_at,
      c.last_error,
      c.primary_used_percent,
      c.primary_reset_at,
      c.secondary_used_percent,
      c.secondary_reset_at,
      c.usage_checked_at,
      c.exhausted_until,
      -- Migration 0383 adds typed cooldown provenance after the original
      -- lease rollout. Keep this allocator query executable against the
      -- pre-0383 compatibility schema while returning the real value once the
      -- additive column exists.
      to_jsonb(c) ->> 'exhausted_kind' as exhausted_kind,
      to_jsonb(c) ->> 'exhausted_revision' as exhausted_revision,
      -- Plan entitlement columns follow the same compatibility pattern.
      to_jsonb(c) ->> 'plan_checked_at' as plan_checked_at,
      to_jsonb(c) -> 'plan_entitlement_exclusion' as plan_entitlement_exclusion,
      c.selection_count,
      c.last_selected_at,
      ${
        input.source === "organization"
          ? sql`opengeni_private.codex_organization_live_lease_count(
              ${input.accountId}::uuid,
              c.id,
              ${input.excludeTurnId ?? null}::uuid
            )`
          : sql`count(l.id) filter (
              where l.leased_until > clock_timestamp()
                and (${input.excludeTurnId ?? null}::uuid is null or l.turn_id <> ${input.excludeTurnId ?? null})
            )::int`
      } as active_lease_count
    from codex_subscription_credentials c
    left join codex_credential_leases l
      on ${input.source === "organization" ? sql`false` : sql`l.workspace_id = ${input.workspaceId} and l.credential_id = c.id`}
    where c.account_id = ${input.accountId}
      and ${
        input.source === "organization"
          ? sql`c.authority_scope = 'organization' and c.organization_id = ${input.accountId}`
          : legacyWorkspaceOnly
            ? sql`c.workspace_id = ${input.workspaceId}`
            : sql`c.authority_scope in ('workspace', 'user') and c.workspace_id = ${input.workspaceId}`
      }
    group by c.id
    order by c.created_at asc, c.id asc
  `);
  return (rows as unknown as CodexLeaseCandidateRow[]).map((row) =>
    mapCodexLeaseCandidate(row, input.activeCredentialId),
  );
}

export async function canSpendCodexExtraCreditsForTurn(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    credentialId: string;
    holderId: string;
    generation: number;
  },
  select: (
    context: CodexCredentialLeaseSelectionContext,
    session: CodexCredentialLeaseSessionState,
  ) => { credentialId: string | null },
): Promise<boolean> {
  return await withSessionActivityRlsContext(db, input, async (tx) => {
    const [turn] = await tx
      .select({ metadata: schema.sessionTurns.metadata, model: schema.sessionTurns.model })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.accountId, input.accountId),
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          eq(schema.sessionTurns.id, input.turnId),
          eq(schema.sessionTurns.activeAttemptId, input.attemptId),
          eq(schema.sessionTurns.executionGeneration, input.executionGeneration),
          eq(schema.sessionTurns.status, "running"),
        ),
      )
      .limit(1);
    if (!turn) return false;
    const parsed = readCodexCredentialPolicySnapshotV1(turn.metadata);
    if (
      parsed.kind !== "valid" ||
      (parsed.policy.source !== "organization" && parsed.policy.source !== "workspace")
    )
      return false;
    const policy = parsed.policy;
    const condition = await codexCredentialUseCondition(tx, input.workspaceId, input);
    if (!condition) return false;
    const [current] = await tx
      .select({ enabled: schema.codexSubscriptionCredentials.extraCreditsEnabled })
      .from(schema.codexSubscriptionCredentials)
      .where(and(eq(schema.codexSubscriptionCredentials.id, input.credentialId), condition))
      .limit(1);
    if (!current?.enabled) return false;
    const accounts = await listCodexLeaseCandidatesInTransaction(tx, {
      ...input,
      activeCredentialId: policy.activeCredentialId,
      source: policy.source as "organization" | "workspace",
      excludeTurnId: input.turnId,
    });
    const candidate = accounts.find((row) => row.id === input.credentialId);
    if (!candidate) return false;
    // The guard just observed this exhaustion, before the durable settlement.
    candidate.includedUsageUnavailableUntil = new Date(Date.now() + 60_000);
    // This exact lease predates pause. Pause only governs new allocations;
    // consent, model access and hard cooldowns still apply to this request.
    candidate.allocatorEnabled = true;
    const selected = select(
      {
        accounts,
        activeCredentialId: policy.activeCredentialId,
        rotationEnabled: policy.rotationEnabled,
        rotationStrategy: policy.rotationStrategy,
        existingCredentialId: null,
        modelId: turn.model,
        failedCredentialIds: unresolvedCodexCredentialFailures(turn.metadata, accounts),
        policyScope: null,
        unavailableDiagnostics: [],
      },
      {
        pinnedCredentialId: policy.pinnedCredentialId,
        pinSource: policy.pinSource,
        lastCredentialId: policy.lastCredentialId,
      },
    );
    return selected.credentialId === input.credentialId;
  });
}

export async function acquireCodexCredentialLease<
  T,
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    workflowId: string;
    workflowRunId: string;
    dispatchId: string;
    expectedRedispatches: number;
    /** Unique Temporal/local activity execution id used as the zombie fence. */
    holderId: string;
    /** Pins must not move the workspace-global cursor. */
    advanceActivePointer: boolean;
    /**
     * Optional downstream parser for private accepted-turn policy metadata.
     * It is pure, runs under the turn/rotation transaction, and must not query
     * pool membership itself. This module stores or interprets no pool identifiers.
     */
    resolvePolicyScope?: CodexCredentialLeasePolicyScopeResolver<TPolicyScope>;
    /**
     * Optional downstream membership policy for NEW allocations only. A live
     * exact-turn lease is offered to the selector against the complete workspace
     * rows first and can never be filtered out here.
     */
    filterNewAllocationCandidates?: CodexCredentialLeaseCandidateFilter<
      TPolicyScope,
      TUnavailableDiagnostic
    >;
    leaseTtlMs?: number;
  },
  select: (
    context: CodexCredentialLeaseSelectionContext<TPolicyScope, TUnavailableDiagnostic>,
    sessionCodexState: CodexCredentialLeaseSessionState,
  ) => CodexCredentialLeaseSelection<T>,
): Promise<CodexCredentialLeaseResult<T, TUnavailableDiagnostic>> {
  const leaseTtlMs = input.leaseTtlMs ?? CODEX_CREDENTIAL_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("Codex credential lease TTL must be positive");
  }
  if (!input.holderId.trim()) {
    throw new Error("Codex credential lease holder id is required");
  }
  if (!Number.isSafeInteger(input.executionGeneration) || input.executionGeneration < 1) {
    throw new Error("Codex credential lease execution generation must be positive");
  }
  if (!Number.isSafeInteger(input.expectedRedispatches) || input.expectedRedispatches < 0) {
    throw new Error("Codex credential lease redispatch fence must be non-negative");
  }
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await lockWorkspaceCodexSubscriptionSource(tx, input.workspaceId);
      const source = await getWorkspaceCodexSubscriptionSourceScoped(tx, input.workspaceId);
      if (source.accountId !== input.accountId) {
        throw new Error("Codex subscription source account does not match the turn account");
      }
      const allocationSource = await codexSourceForTurn(
        tx,
        input.workspaceId,
        input.turnId,
        source.effectiveSource,
      );
      const organizationSource = allocationSource === "organization";
      if (organizationSource) {
        await tx.execute(sql`
          insert into organization_codex_rotation_settings
            (account_id)
          values (${input.accountId})
          on conflict (account_id) do nothing
        `);
      } else {
        await tx.execute(sql`
          insert into codex_rotation_settings
            (account_id, workspace_id)
          values (${input.accountId}, ${input.workspaceId})
          on conflict (workspace_id) do nothing
        `);
      }
      const settingsRows = organizationSource
        ? await tx.execute(sql<{
            active_credential_id: string | null;
            rotation_enabled: boolean;
            rotation_strategy: string;
          }>`
            select active_credential_id, rotation_enabled, rotation_strategy
            from organization_codex_rotation_settings
            where account_id = ${input.accountId}
            for update
          `)
        : await tx.execute(sql<{
            active_credential_id: string | null;
            rotation_enabled: boolean;
            rotation_strategy: string;
          }>`
        select active_credential_id, rotation_enabled, rotation_strategy
        from codex_rotation_settings
        where account_id = ${input.accountId} and workspace_id = ${input.workspaceId}
        for update
      `);
      const settingsRow = settingsRows[0];
      if (!settingsRow) {
        throw new Error(`Codex rotation settings not visible for workspace ${input.workspaceId}`);
      }
      const workspaceControl = await lockWorkspaceInferenceControl(
        tx as unknown as Database,
        input.workspaceId,
        "share",
      );
      // Lease FKs need the workspace identity. Take it before any session/turn
      // locks, matching capacity and connection-use lifecycle writers; a late
      // FK request can otherwise wait behind a workspace writer needing our turn.
      await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "already_locked",
      });
      // Rotation row -> durable turn is the common allocator/waiter lock order.
      // Fail closed before taking a credential: the turn and allocator must be
      // inside exactly the same RLS-scoped workspace/account. A downstream
      // accepted-turn policy is parsed from this locked metadata while the
      // rotation transaction is held.
      const sessions = await tx.execute(sql<{
        id: string;
        status: string;
        active_turn_id: string | null;
        codex_pinned_credential_id: string | null;
        codex_pin_source: string | null;
        codex_last_credential_id: string | null;
      }>`
        select id, status, active_turn_id,
               codex_pinned_credential_id, codex_pin_source, codex_last_credential_id
        from sessions
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and id = ${input.sessionId}
        for share
      `);
      const turns = await tx.execute(sql<{
        id: string;
        session_id: string;
        status: string;
        active_attempt_id: string | null;
        execution_generation: number;
        metadata: Record<string, unknown> | null;
        model: string;
      }>`
        select id, session_id, status, active_attempt_id, execution_generation, metadata, model
        from session_turns
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and id = ${input.turnId}
        for update
      `);
      const attempts = await tx.execute(sql<{
        id: string;
        state: string;
        execution_generation: number;
        temporal_workflow_id: string;
        temporal_workflow_run_id: string;
        temporal_activity_id: string;
      }>`
        select id, state, execution_generation, temporal_workflow_id,
               temporal_workflow_run_id, temporal_activity_id
        from session_turn_attempts
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and session_id = ${input.sessionId}
          and turn_id = ${input.turnId}
          and id = ${input.attemptId}
        for share
      `);
      const session = sessions[0];
      const turn = turns[0];
      const attempt = attempts[0];
      if (!turn) {
        throw new Error(`Session turn not found for Codex lease: ${input.turnId}`);
      }
      const dispatch = readTurnDispatchMetadata(turn.metadata);
      const currentRedispatches = Number(turn.metadata?.workerDeathRedispatches ?? 0);
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        input.workspaceId,
        input.sessionId,
        { workspaceControl },
      );
      if (
        !session ||
        !attempt ||
        effectiveControl.state !== "active" ||
        session.status !== "running" ||
        session.active_turn_id !== input.turnId ||
        turn.session_id !== input.sessionId ||
        turn.status !== "running" ||
        turn.active_attempt_id !== input.attemptId ||
        Number(turn.execution_generation) !== input.executionGeneration ||
        (attempt.state !== "claimed" && attempt.state !== "running") ||
        Number(attempt.execution_generation) !== input.executionGeneration ||
        attempt.temporal_workflow_id !== input.workflowId ||
        attempt.temporal_workflow_run_id !== input.workflowRunId ||
        attempt.temporal_activity_id !== input.dispatchId ||
        dispatch.kind !== "valid" ||
        dispatch.attempt?.id !== input.dispatchId ||
        currentRedispatches !== input.expectedRedispatches
      ) {
        throw new CodexCredentialLeaseAttemptFencedError();
      }
      const sessionCodexState: CodexCredentialLeaseSessionState = {
        pinnedCredentialId: session.codex_pinned_credential_id,
        pinSource:
          session.codex_pin_source === "manual" || session.codex_pin_source === "policy"
            ? session.codex_pin_source
            : null,
        lastCredentialId: session.codex_last_credential_id,
      };
      const acceptedCodexPolicy = readCodexCredentialPolicySnapshotV1(turn.metadata);
      const codexPolicySnapshot =
        acceptedCodexPolicy.kind === "valid" ? acceptedCodexPolicy.policy : null;
      // Legacy policies use the pre-change sidecar binding, when present.
      // Never reinterpret a source-less accepted policy after a source cutover.
      const acceptedSource = codexPolicySnapshot?.source ?? allocationSource;
      const acceptedDisabledSource = acceptedSource === "disabled";
      const acceptedOrganizationSource = acceptedSource === "organization";
      const acceptedSessionCodexState: CodexCredentialLeaseSessionState = codexPolicySnapshot
        ? {
            pinnedCredentialId: codexPolicySnapshot.pinnedCredentialId,
            pinSource: codexPolicySnapshot.pinSource,
            lastCredentialId: codexPolicySnapshot.lastCredentialId,
          }
        : sessionCodexState;
      const failoverMetadata = codexFailoverMetadata(turn.metadata);
      if (failoverMetadata.exhausted && failoverMetadata.maxFailovers !== null) {
        throw new CodexCredentialFailoverExhaustedError(
          failoverMetadata.failoverCount,
          failoverMetadata.maxFailovers,
        );
      }
      const policyScope = input.resolvePolicyScope?.(turn.metadata ?? {}) ?? null;
      let activeCredentialId = codexPolicySnapshot
        ? codexPolicySnapshot.activeCredentialId
        : settingsRow.active_credential_id;
      const rotationEnabled = codexPolicySnapshot
        ? codexPolicySnapshot.rotationEnabled
        : settingsRow.rotation_enabled;
      const rotationStrategy = codexPolicySnapshot
        ? codexPolicySnapshot.rotationStrategy
        : settingsRow.rotation_strategy;

      await tx.execute(sql`
        delete from codex_credential_leases
        where workspace_id = ${input.workspaceId} and leased_until <= clock_timestamp()
      `);
      const existingRows = await tx.execute(
        sql<{
          credential_id: string;
          holder_id: string;
          generation: number;
        }>`
          select credential_id, holder_id, generation from codex_credential_leases
          where workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and leased_until > clock_timestamp()
          limit 1
        `,
      );
      const existingCredentialId = existingRows[0]?.credential_id ?? null;

      const allAccounts = acceptedDisabledSource
        ? []
        : await listCodexLeaseCandidatesInTransaction(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            activeCredentialId,
            source: acceptedOrganizationSource ? "organization" : "workspace",
            excludeTurnId: input.turnId,
          });
      if (organizationSource) {
        activeCredentialId = assignedConnectionDefault(activeCredentialId, allAccounts);
        for (const account of allAccounts) account.isActive = account.id === activeCredentialId;
      }
      const sameTurnCredentialId = existingCredentialId;
      const selectionContext = (
        accounts: CodexLeaseAccountStatus[],
        unavailableDiagnostics: readonly TUnavailableDiagnostic[],
      ) => ({
        accounts,
        activeCredentialId,
        rotationEnabled,
        rotationStrategy,
        existingCredentialId,
        failedCredentialIds: unresolvedCodexCredentialFailures(turn.metadata, accounts),
        failoverExhausted: failoverMetadata.exhausted,
        modelId: turn.model,
        policyScope,
        unavailableDiagnostics,
      });
      let accounts = allAccounts;
      let unavailableDiagnostics: readonly TUnavailableDiagnostic[] = [];
      let selected: CodexCredentialLeaseSelection<T> | undefined;
      if (sameTurnCredentialId !== null) {
        const sameTurnSelection = select(
          selectionContext(allAccounts, []),
          acceptedSessionCodexState,
        );
        if (sameTurnSelection.credentialId === sameTurnCredentialId) {
          selected = sameTurnSelection;
        }
      }

      // A live exact-turn lease is resolved before any future pool membership
      // filter. The normal selector still owns health validation: a quarantined
      // row falls through to scoped new acquisition rather than being reused.
      if (!selected) {
        const filtered = filterCodexLeaseCandidatesForPolicy(
          allAccounts,
          policyScope,
          input.filterNewAllocationCandidates,
        );
        accounts = filtered.accounts;
        unavailableDiagnostics = filtered.unavailableDiagnostics;
        selected = select(
          selectionContext(accounts, unavailableDiagnostics),
          acceptedSessionCodexState,
        );
      }

      // Capture the accepted policy before returning either a credential or a
      // durable no-credential result. A turn that enters its first capacity
      // wait must not remain free to observe later rotation/pin mutations.
      const acceptedSnapshot =
        codexPolicySnapshot ??
        CodexCredentialPolicySnapshotV1.parse({
          schemaVersion: 1,
          activeCredentialId: settingsRow.active_credential_id,
          rotationEnabled: settingsRow.rotation_enabled,
          rotationStrategy: settingsRow.rotation_strategy,
          source: allocationSource,
          pinnedCredentialId: sessionCodexState.pinnedCredentialId,
          pinSource: sessionCodexState.pinSource,
          lastCredentialId: sessionCodexState.lastCredentialId,
        });
      if (codexPolicySnapshot === null) {
        const [snapshottedTurn] = await tx
          .update(schema.sessionTurns)
          .set({
            metadata: metadataWithCodexCredentialPolicySnapshotV1(turn.metadata, acceptedSnapshot),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessionTurns.accountId, input.accountId),
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              eq(schema.sessionTurns.status, "running"),
              eq(schema.sessionTurns.activeAttemptId, input.attemptId),
              eq(schema.sessionTurns.executionGeneration, input.executionGeneration),
            ),
          )
          .returning({ id: schema.sessionTurns.id });
        if (!snapshottedTurn) {
          throw new CodexCredentialLeaseAttemptFencedError();
        }
      }
      if (selected.credentialId === null) {
        if (existingCredentialId !== null) {
          await tx.execute(sql`
            delete from codex_credential_leases
            where workspace_id = ${input.workspaceId} and turn_id = ${input.turnId}
          `);
        }
        return {
          decision: selected.decision,
          accounts,
          activeCredentialId,
          rotationEnabled,
          rotationStrategy,
          sessionCodexState: acceptedSessionCodexState,
          poolAccountCount: allAccounts.length,
          codexPolicySnapshot: acceptedSnapshot,
          codexPolicySnapshotReused: codexPolicySnapshot !== null,
          credentialId: null,
          reused: false,
          holderId: null,
          generation: null,
          leasedUntil: null,
          unavailableDiagnostics,
          advanceActivePointer: false,
          failoverLimit:
            failoverMetadata.maxFailovers ?? codexCredentialFailoverLimitForLease(accounts, null),
        };
      }
      const selectedAccount = accounts.find((account) => account.id === selected.credentialId);
      if (!selectedAccount) {
        throw new Error("Codex lease selector returned a credential outside the workspace pool");
      }
      if (!selectedAccount.allocatorEnabled && selectedAccount.id !== existingCredentialId) {
        throw new Error("Codex lease selector returned a credential disabled for new allocations");
      }

      const advanceActivePointer =
        codexPolicySnapshot === null &&
        input.advanceActivePointer &&
        acceptedSessionCodexState.pinnedCredentialId === null &&
        selected.advanceActivePointer !== false;

      const reused = existingCredentialId === selected.credentialId;
      const leaseRows = await tx.execute(
        sql<{
          holder_id: string;
          generation: number;
          leased_until: Date | string;
        }>`
        insert into codex_credential_leases
          (account_id, workspace_id, credential_id, turn_id, holder_id, generation, leased_until)
        values
          (${input.accountId}, ${input.workspaceId}, ${selected.credentialId}, ${input.turnId}, ${input.holderId}, 1, clock_timestamp() + (${leaseTtlMs} * interval '1 millisecond'))
        on conflict (workspace_id, turn_id) do update set
          credential_id = excluded.credential_id,
          holder_id = excluded.holder_id,
          generation = case
            when codex_credential_leases.holder_id = excluded.holder_id
              then codex_credential_leases.generation
            else codex_credential_leases.generation + 1
          end,
          leased_until = excluded.leased_until,
          updated_at = now()
        returning holder_id, generation, leased_until
      `,
      );
      const leasedUntil = codexMetadataDate(leaseRows[0]?.leased_until);
      if (!leasedUntil) {
        throw new Error("Codex credential lease insert returned no expiry");
      }
      if (!reused) {
        await tx.execute(sql`
          update codex_subscription_credentials
          set selection_count = selection_count + 1,
              last_selected_at = now()
          where account_id = ${input.accountId}
            and id = ${selected.credentialId}
        `);
      }
      if (advanceActivePointer && activeCredentialId !== selected.credentialId) {
        if (organizationSource) {
          await tx.execute(sql`
            update organization_codex_rotation_settings
            set active_credential_id = ${selected.credentialId}, updated_at = now()
            where account_id = ${input.accountId}
          `);
        } else {
          await tx.execute(sql`
            update codex_rotation_settings
            set active_credential_id = ${selected.credentialId}, updated_at = now()
            where account_id = ${input.accountId} and workspace_id = ${input.workspaceId}
          `);
        }
      }
      return {
        decision: selected.decision,
        accounts,
        activeCredentialId,
        rotationEnabled,
        rotationStrategy,
        sessionCodexState: acceptedSessionCodexState,
        poolAccountCount: allAccounts.length,
        codexPolicySnapshot: acceptedSnapshot,
        codexPolicySnapshotReused: codexPolicySnapshot !== null,
        credentialId: selected.credentialId,
        reused,
        holderId: leaseRows[0]?.holder_id ?? input.holderId,
        generation: Number(leaseRows[0]?.generation),
        leasedUntil,
        unavailableDiagnostics,
        advanceActivePointer,
        failoverLimit:
          failoverMetadata.maxFailovers ??
          codexCredentialFailoverLimitForLease(accounts, selected.credentialId),
      };
    },
  );
}

function mapCodexCapacityWaiter(
  row: typeof schema.codexCapacityWaiters.$inferSelect,
): CodexCapacityWait {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    goalId: row.goalId,
    blockedTurnId: row.blockedTurnId,
    blockedTurnGeneration: row.blockedTurnGeneration,
    workflowId: row.workflowId,
    generation: row.generation,
    status: row.status as CodexCapacityWaitStatus,
    goalVersion: row.goalVersion,
    policyHash: row.policyHash,
    earliestResetAt: row.earliestResetAt,
    nextCheckAt: row.nextCheckAt,
    resetKind: row.resetKind as CodexCapacityResetKind,
    refreshAttempt: row.refreshAttempt,
    wakeRevision: row.wakeRevision,
    observedWakeRevision: row.observedWakeRevision,
    lastWakeReason: row.lastWakeReason,
    resumedUpdateId: row.resumedUpdateId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function codexCapacityPolicyHashFromTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.codexCredentialPolicyHash;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function lockExistingCodexRotationSettingsForCapacity(
  tx: Database,
  workspaceId: string,
  turnId?: string,
  mutationSource?: "workspace" | "organization",
): Promise<{
  accountId: string;
  source: EffectiveCodexSubscriptionSource;
  activeCredentialId: string | null;
  rotationEnabled: boolean;
  rotationStrategy: string;
} | null> {
  await lockWorkspaceCodexSubscriptionSource(tx, workspaceId);
  const source = await getWorkspaceCodexSubscriptionSourceScoped(tx, workspaceId);
  if (turnId) {
    source.effectiveSource = await codexSourceForTurn(
      tx,
      workspaceId,
      turnId,
      source.effectiveSource,
    );
  } else if (mutationSource) {
    source.effectiveSource = mutationSource;
  }
  const rows =
    source.effectiveSource === "organization"
      ? await tx.execute(sql<{
          account_id: string;
          active_credential_id: string | null;
          rotation_enabled: boolean;
          rotation_strategy: string;
        }>`
        select account_id, active_credential_id, rotation_enabled, rotation_strategy
        from organization_codex_rotation_settings
        where account_id = ${source.accountId}
        for update
      `)
      : await tx.execute(sql<{
          account_id: string;
          active_credential_id: string | null;
          rotation_enabled: boolean;
          rotation_strategy: string;
        }>`
        select account_id, active_credential_id, rotation_enabled, rotation_strategy
        from codex_rotation_settings
        where workspace_id = ${workspaceId}
        for update
      `);
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id,
        source: source.effectiveSource,
        activeCredentialId: row.active_credential_id,
        rotationEnabled: row.rotation_enabled,
        rotationStrategy: row.rotation_strategy,
      }
    : null;
}

function nextCodexCapacityCheckAt(
  earliestResetAt: Date | null,
  resetKind: CodexCapacityResetKind,
  refreshAttempt: number,
  now: Date,
): Date {
  if (
    resetKind === "authoritative" &&
    earliestResetAt !== null &&
    earliestResetAt.getTime() > now.getTime()
  ) {
    return earliestResetAt;
  }
  return new Date(now.getTime() + codexCapacityRefreshBackoffMs(refreshAttempt));
}

export async function armCodexCapacityWait(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    workflowId: string;
    goalId?: string | null;
    goalVersion?: number | null;
    policyHash?: string | null;
    earliestResetAt: Date | null;
    resetKind: CodexCapacityResetKind;
    failurePayload: Record<string, unknown>;
    /** Required on reactive failures that already own a credential lease. */
    leaseFence?: { holderId: string; generation: number };
    /** Worker-death dispatch generation observed before model execution. */
    expectedRedispatches?: number;
    now?: Date;
  },
): Promise<ArmCodexCapacityWaitResult> {
  const now = input.now ?? new Date();
  const goalId = input.goalId ?? null;
  const goalVersion = input.goalVersion ?? null;
  if (
    (goalId === null) !== (goalVersion === null) ||
    (goalVersion !== null && (!Number.isSafeInteger(goalVersion) || goalVersion < 1))
  ) {
    throw new Error("Codex capacity goal fence must be absent or contain a positive version");
  }
  return await retrySessionActivityRls(
    db,
    input.workspaceId,
    {
      stage: "session_lifecycle_outbox.arm_codex_capacity_wait",
      eventTypes: ["codex.capacity.waiting", "turn.failed", "session.status.changed"],
      maxAttempts: 3,
    },
    async (scopedDb) =>
      await withSessionActivitySavepoint(scopedDb, async (tx) => {
        const rotation = await lockExistingCodexRotationSettingsForCapacity(
          tx,
          input.workspaceId,
          input.turnId,
        );
        if (!rotation || rotation.accountId !== input.accountId) {
          return { action: "stale", waiter: null, events: [] } as const;
        }
        // Child-lifecycle prefix: the parent session is locked with the child
        // so the capacity-wait notice can be enqueued in this same commit.
        const locks = await lockChildLifecycleOutboxWriteRowsTx(tx, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          attemptId: input.attemptId,
        });
        const session = locks.session;
        const turn = locks.turns[0];
        const attempt = locks.attempts[0];
        const effectiveControl = session
          ? await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
              workspaceControl: locks.control ?? undefined,
            })
          : null;
        const [goal] = goalId
          ? await tx
              .select()
              .from(schema.sessionGoals)
              .where(
                and(
                  eq(schema.sessionGoals.workspaceId, input.workspaceId),
                  eq(schema.sessionGoals.id, goalId),
                  eq(schema.sessionGoals.sessionId, input.sessionId),
                ),
              )
              .for("update")
              .limit(1)
          : [];
        const leaseRows = input.leaseFence
          ? await tx.execute(sql<{ holder_id: string; generation: number }>`
              select holder_id, generation
              from codex_credential_leases
              where account_id = ${input.accountId}
                and workspace_id = ${input.workspaceId}
                and turn_id = ${input.turnId}
                and leased_until > clock_timestamp()
              for update
            `)
          : [];
        const [existing] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);

        const exactRowsMatch =
          session?.accountId === input.accountId &&
          turn?.accountId === input.accountId &&
          turn?.sessionId === input.sessionId &&
          attempt?.accountId === input.accountId &&
          attempt?.sessionId === input.sessionId &&
          attempt?.turnId === input.turnId &&
          attempt?.executionGeneration === turn?.executionGeneration;
        if (!exactRowsMatch) {
          return {
            action: "stale",
            waiter: existing ? mapCodexCapacityWaiter(existing) : null,
            events: [],
          } as const;
        }
        if (
          existing?.status === "waiting" &&
          existing.blockedTurnId === input.turnId &&
          existing.blockedTurnGeneration === turn?.executionGeneration &&
          turn?.status === "waiting_capacity" &&
          session?.status === "waiting_capacity" &&
          session.activeTurnId === input.turnId
        ) {
          return {
            action: "waiting",
            waiter: mapCodexCapacityWaiter(existing),
            events: [],
          } as const;
        }
        const policyHash =
          input.policyHash ?? codexCapacityPolicyHashFromTurnMetadata(turn?.metadata);
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        const lease = leaseRows[0];
        const leaseFenceValid =
          !input.leaseFence ||
          (lease?.holder_id === input.leaseFence.holderId &&
            Number(lease.generation) === input.leaseFence.generation &&
            currentRedispatches === (input.expectedRedispatches ?? currentRedispatches));
        if (
          !session ||
          !turn ||
          effectiveControl?.state !== "active" ||
          effectiveControl.settlement !== null ||
          session.activeTurnId !== input.turnId ||
          session.status !== "running" ||
          (goalId !== null &&
            (!goal || goal.status !== "active" || goal.version !== goalVersion)) ||
          turn.status !== "running" ||
          turn.activeAttemptId !== input.attemptId ||
          !leaseFenceValid ||
          codexCapacityPolicyHashFromTurnMetadata(turn.metadata) !== policyHash
        ) {
          return {
            action: "stale",
            waiter: existing ? mapCodexCapacityWaiter(existing) : null,
            events: [],
          } as const;
        }

        const recovery = readCodexCapacityRecovery(turn.metadata);
        const falseResumption =
          recovery.resumeGeneration !== null &&
          recovery.resumeGeneration <= turn.executionGeneration &&
          existing?.status === "resumed" &&
          existing.blockedTurnId === turn.id &&
          existing.blockedTurnGeneration + 1 === recovery.resumeGeneration;
        // A worker-death redispatch or credential failover can replace the first
        // resumed attempt without making progress. Keep its one resumption
        // receipt until an exact current attempt closes it or proves progress.
        // The active-attempt/generation checks above reject stale predecessors.
        const falseResumptions = recovery.falseResumptions + (falseResumption ? 1 : 0);
        const stopped = falseResumptions >= CODEX_CAPACITY_FALSE_RESUMPTION_LIMIT;
        const retryNotBefore =
          falseResumption && !stopped
            ? new Date(
                now.getTime() + codexFalseResumptionBackoffMs(falseResumptions),
              ).toISOString()
            : recovery.retryNotBefore;
        const recoveryMetadata = {
          ...metadataWithoutTurnDispatchAttempt(turn.metadata),
          [CODEX_CAPACITY_RECOVERY_KEY]: {
            falseResumptions,
            resumeGeneration: null,
            retryNotBefore,
          },
        };
        const [waitingPrompt] = stopped
          ? await tx
              .select({ id: schema.sessionTurns.id })
              .from(schema.sessionTurns)
              .where(
                and(
                  eq(schema.sessionTurns.workspaceId, input.workspaceId),
                  eq(schema.sessionTurns.sessionId, input.sessionId),
                  eq(schema.sessionTurns.status, "queued"),
                  inArray(schema.sessionTurns.source, ["user", "api"]),
                ),
              )
              .limit(1)
          : [];
        const sessionStatus = stopped ? (waitingPrompt ? "queued" : "failed") : "waiting_capacity";
        await closeSessionTurnAttemptInTransaction(tx, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: stopped ? "failed" : "waiting_capacity",
          closedAt: now,
        });

        const generation = (existing?.generation ?? 0) + 1;
        const capacityCheckAt = nextCodexCapacityCheckAt(
          input.earliestResetAt,
          input.resetKind,
          0,
          now,
        );
        const nextCheckAt = new Date(
          Math.max(capacityCheckAt.getTime(), retryNotBefore ? Date.parse(retryNotBefore) : 0),
        );
        const wakeRevision = (existing?.wakeRevision ?? 0) + 1;
        const waiterValues = {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          goalId,
          blockedTurnId: input.turnId,
          blockedTurnGeneration: turn.executionGeneration,
          workflowId: input.workflowId,
          generation,
          status: stopped ? "superseded" : "waiting",
          goalVersion,
          policyHash,
          earliestResetAt: input.earliestResetAt,
          nextCheckAt,
          resetKind: input.resetKind,
          refreshAttempt: 0,
          // Arming follows an allocator evaluation in this same transaction,
          // so this generation has already observed its own initial revision.
          // Only a later capacity mutation creates pending outbox work.
          wakeRevision,
          observedWakeRevision: wakeRevision,
          lastWakeReason: stopped ? "capacity_recovery_stopped" : "capacity_wait_armed",
          resumedUpdateId: null,
          updatedAt: now,
        } as const;
        const [waiterRow] = existing
          ? await tx
              .update(schema.codexCapacityWaiters)
              .set(waiterValues)
              .where(eq(schema.codexCapacityWaiters.id, existing.id))
              .returning()
          : await tx.insert(schema.codexCapacityWaiters).values(waiterValues).returning();
        if (!waiterRow) {
          throw new Error("Codex capacity wait arm returned no waiter row");
        }

        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: "codex_capacity_wait",
          sequence,
          now,
          preserveInterruptionRows: !stopped,
        });
        sequence = closedTools.sequence;
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values(
            withLosslessContentWriteVersion(
              [
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: stopped ? "turn.failed" : "codex.capacity.waiting",
                  payload: {
                    ...input.failurePayload,
                    recovery: "codex_capacity",
                    retryable: true,
                    rotated: true,
                    waiterId: waiterRow.id,
                    generation: waiterRow.generation,
                    goalId,
                    goalVersion,
                    blockedTurnGeneration: turn.executionGeneration,
                    policyHash,
                    resetKind: input.resetKind,
                    earliestResetAt: input.earliestResetAt?.toISOString() ?? null,
                    nextCheckAt: nextCheckAt.toISOString(),
                    falseResumptions,
                    ...(stopped
                      ? {
                          error:
                            "Automatic capacity recovery stopped after 10 resumptions returned immediately to unavailable capacity. Use Retry or send Continue after checking subscription capacity.",
                          code: "codex_capacity_recovery_exhausted",
                          recovery: "user_message",
                          recoveryExhausted: true,
                          retryable: false,
                          rotated: false,
                        }
                      : {}),
                  },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "session.status.changed",
                  payload: {
                    status: sessionStatus,
                    reason: stopped ? "codex_capacity_recovery_exhausted" : "codex_capacity",
                  },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
              ],
              "payload",
              "payloadCodecVersion",
            ),
          )
          .returning();
        const [waitingTurn] = await tx
          .update(schema.sessionTurns)
          .set({
            status: stopped ? "failed" : "waiting_capacity",
            activeAttemptId: null,
            metadata: recoveryMetadata,
            version: turn.version + 1,
            finishedAt: stopped ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.status, "running"),
              eq(schema.sessionTurns.activeAttemptId, input.attemptId),
            ),
          )
          .returning({ id: schema.sessionTurns.id });
        if (!waitingTurn) {
          throw new Error("Codex capacity blocked turn changed during atomic arm");
        }
        const [waitingSession] = await tx
          .update(schema.sessions)
          .set({
            status: sessionStatus,
            activeTurnId: stopped ? null : input.turnId,
            lastSequence: sequence,
            ...(stopped ? { queueVersion: session.queueVersion + 1 } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.status, "running"),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          )
          .returning({ id: schema.sessions.id });
        if (!waitingSession) {
          throw new Error("Codex capacity session changed during atomic arm");
        }
        if (stopped) {
          await cancelTurnInteractionInterventionsInTransaction(tx, input);
          await settleSessionMaintenanceInTransaction(tx, input);
          const terminalEvent = inserted[0]!;
          await projectSessionRealtimeDelegationTerminalInTransaction(tx, {
            ...input,
            turnStatus: "failed",
            terminalEvent: {
              id: terminalEvent.id,
              type: "turn.failed",
              payload: sessionEventPayloadRecord(
                terminalEvent.payload,
                terminalEvent.payloadCodecVersion,
              ),
            },
            now,
          });
          await enqueueFailedChildOutboxForTurnTx(tx, input.workspaceId, session, turn);
          await tx
            .update(schema.sessionGoals)
            .set({ continuationSuppressedTurnId: turn.id, updatedAt: now })
            .where(
              and(
                eq(schema.sessionGoals.workspaceId, input.workspaceId),
                eq(schema.sessionGoals.sessionId, input.sessionId),
                eq(schema.sessionGoals.status, "active"),
              ),
            );
        } else
          await enqueueChildWaitingCapacityOutboxTx(tx, input.workspaceId, session, {
            turnId: input.turnId,
            waiterId: waiterRow.id,
            provider: "codex",
            nextCheckAt,
          });
        if (input.leaseFence) {
          await tx.execute(sql`
            delete from codex_credential_leases
            where account_id = ${input.accountId}
              and workspace_id = ${input.workspaceId}
              and turn_id = ${input.turnId}
              and holder_id = ${input.leaseFence.holderId}
              and generation = ${input.leaseFence.generation}
          `);
        }
        if (stopped)
          return {
            action: "stopped",
            sessionStatus: waitingPrompt ? "queued" : "failed",
            waiter: mapCodexCapacityWaiter(waiterRow),
            events: [...closedTools.events, ...inserted.map(mapEvent)],
          } as const;
        return {
          action: "waiting",
          waiter: mapCodexCapacityWaiter(waiterRow),
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

export async function getCodexCapacityWaitForSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<CodexCapacityWait | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.codexCapacityWaiters)
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.sessionId, sessionId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      )
      .limit(1);
    return row ? mapCodexCapacityWaiter(row) : null;
  });
}

type CodexCapacityMutationInput = {
  acceptedTurnId?: string | undefined;
  /** Local management writes do not follow the live source preference. */
  mutationSource?: "workspace" | "organization" | "effective";
  workspaceId: string;
  reason: string;
  policyHash?: string | null;
};

async function wakeCodexCapacityWaitersInWorkspaceInTransaction(
  tx: Database,
  input: CodexCapacityMutationInput,
  acceptedSource?: EffectiveCodexSubscriptionSource,
): Promise<CodexCapacityWakeTarget[]> {
  const rows = await tx
    .update(schema.codexCapacityWaiters)
    .set({
      wakeRevision: sql`${schema.codexCapacityWaiters.wakeRevision} + 1`,
      lastWakeReason: input.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
        eq(schema.codexCapacityWaiters.status, "waiting"),
        ...(acceptedSource
          ? [
              sql`exists (
          select 1 from session_turns accepted
          left join codex_turn_source_bindings binding
            on binding.turn_id = accepted.id and binding.workspace_id = accepted.workspace_id
          where accepted.id = ${schema.codexCapacityWaiters.blockedTurnId}
            and accepted.workspace_id = ${schema.codexCapacityWaiters.workspaceId}
            and accepted.account_id = ${schema.codexCapacityWaiters.accountId}
            and coalesce(accepted.metadata #>> '{codexCredentialPolicySnapshotV1,source}',
              binding.source, resolve_workspace_codex_subscription_source(accepted.account_id, accepted.workspace_id)) = ${acceptedSource}
        )`,
            ]
          : []),
        ...(input.policyHash !== undefined
          ? [
              input.policyHash === null
                ? isNull(schema.codexCapacityWaiters.policyHash)
                : eq(schema.codexCapacityWaiters.policyHash, input.policyHash),
            ]
          : []),
      ),
    )
    .returning();
  const wakeTargets: CodexCapacityWakeTarget[] = [];
  for (const row of rows) {
    const workflowWakeRevision = await enqueueSessionWorkflowWakeInTransaction(tx, {
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      temporalWorkflowId: row.workflowId,
      reason: "codex_capacity",
    });
    wakeTargets.push({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      workflowId: row.workflowId,
      waiterId: row.id,
      generation: row.generation,
      wakeRevision: row.wakeRevision,
      workflowWakeRevision,
    });
  }
  return wakeTargets;
}

async function wakeOrganizationCodexCapacityWaitersInTransaction(
  tx: Database,
  input: {
    accountId: string;
    reason: string;
    policyHash?: string | null;
    restoreWorkspaceId: string | null;
  },
): Promise<CodexCapacityWakeTarget[]> {
  const wakeTargets: CodexCapacityWakeTarget[] = [];
  await setRlsContext(tx, { accountId: input.accountId, workspaceId: null });
  const workspaceRows = await tx.execute<{ workspace_id: string }>(sql`
    select workspace_id from list_organization_codex_workspace_ids(${input.accountId}::uuid)
    order by workspace_id
  `);
  for (const { workspace_id: workspaceId } of workspaceRows) {
    await setRlsContext(tx, { accountId: input.accountId, workspaceId });
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
    );
    // Current settings do not describe accepted waiters. A workspace that
    // switched away may still have an organization-backed turn. Wakes only
    // request reconciliation; each waiter rechecks its own immutable pool.
    wakeTargets.push(
      ...(await wakeCodexCapacityWaitersInWorkspaceInTransaction(
        tx,
        {
          workspaceId,
          reason: input.reason,
          ...(input.policyHash !== undefined ? { policyHash: input.policyHash } : {}),
        },
        "organization",
      )),
    );
  }
  await setRlsContext(tx, {
    accountId: input.accountId,
    workspaceId: input.restoreWorkspaceId,
  });
  return wakeTargets;
}

async function mutateCodexCapacityInTransaction<T, TDatabase extends Database>(
  tx: TDatabase,
  input: CodexCapacityMutationInput,
  mutate: (tx: TDatabase) => Promise<{ result: T; changed: boolean }>,
): Promise<CodexCapacityMutationResult<T>> {
  await lockWorkspaceCodexSubscriptionSource(tx, input.workspaceId);
  await captureLegacyCodexTurnSources(tx, input.workspaceId);
  const current = await getWorkspaceCodexSubscriptionSourceScoped(tx, input.workspaceId);
  const mutationSource = input.acceptedTurnId
    ? await codexSourceForTurn(tx, input.workspaceId, input.acceptedTurnId, current.effectiveSource)
    : input.mutationSource === "effective"
      ? current.effectiveSource
      : (input.mutationSource ?? "workspace");
  await lockExistingCodexRotationSettingsForCapacity(
    tx,
    input.workspaceId,
    input.acceptedTurnId,
    input.mutationSource === "effective" ? undefined : (input.mutationSource ?? "workspace"),
  );
  const mutation = await mutate(tx);
  if (!mutation.changed) {
    return { result: mutation.result, wakeTargets: [] };
  }
  const wakeTargets =
    mutationSource === "disabled"
      ? []
      : mutationSource === "organization"
        ? await wakeOrganizationCodexCapacityWaitersInTransaction(tx, {
            accountId: current.accountId,
            reason: input.reason,
            ...(input.policyHash !== undefined ? { policyHash: input.policyHash } : {}),
            restoreWorkspaceId: input.workspaceId,
          })
        : await wakeCodexCapacityWaitersInWorkspaceInTransaction(tx, input, "workspace");
  return {
    result: mutation.result,
    wakeTargets,
  };
}

export async function withCodexCapacityMutation<T>(
  db: Database,
  input: CodexCapacityMutationInput,
  mutate: (tx: Database) => Promise<{ result: T; changed: boolean }>,
): Promise<CodexCapacityMutationResult<T>> {
  return await withWorkspaceRls(db, input.workspaceId, (tx) =>
    mutateCodexCapacityInTransaction(tx, input, mutate),
  );
}

export async function withSessionCodexCapacityMutation<T>(
  db: Database,
  input: CodexCapacityMutationInput,
  mutate: (tx: SessionActivityDatabase) => Promise<{ result: T; changed: boolean }>,
): Promise<CodexCapacityMutationResult<T>> {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, (tx) =>
    mutateCodexCapacityInTransaction(tx, input, mutate),
  );
}

export async function listPendingCodexCapacityWakeTargets(
  db: Database,
  workspaceId: string,
): Promise<CodexCapacityWakeTarget[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        waiter: schema.codexCapacityWaiters,
        workflowWakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision,
      })
      .from(schema.codexCapacityWaiters)
      .innerJoin(
        schema.sessionWorkflowWakeOutbox,
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, schema.codexCapacityWaiters.workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, schema.codexCapacityWaiters.sessionId),
        ),
      )
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
          sql`${schema.codexCapacityWaiters.wakeRevision} > ${schema.codexCapacityWaiters.observedWakeRevision}`,
        ),
      );
    return rows.map(({ waiter: row, workflowWakeRevision }) => ({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      workflowId: row.workflowId,
      waiterId: row.id,
      generation: row.generation,
      wakeRevision: row.wakeRevision,
      workflowWakeRevision,
    }));
  });
}

async function supersedeCodexCapacityWaitInTransaction(
  tx: SessionActivityDatabase,
  input: {
    session: typeof schema.sessions.$inferSelect;
    blockedTurn: typeof schema.sessionTurns.$inferSelect;
    waiter: typeof schema.codexCapacityWaiters.$inferSelect;
    reason: string;
    now: Date;
  },
): Promise<{ waiter: CodexCapacityWait; events: SessionEvent[] }> {
  const [updated] = await tx
    .update(schema.codexCapacityWaiters)
    .set({
      status: "superseded",
      observedWakeRevision: input.waiter.wakeRevision,
      lastWakeReason: input.reason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.codexCapacityWaiters.id, input.waiter.id),
        eq(schema.codexCapacityWaiters.status, "waiting"),
      ),
    )
    .returning();
  if (!updated) {
    return { waiter: mapCodexCapacityWaiter(input.waiter), events: [] };
  }
  const turnWasCurrent = input.session.activeTurnId === input.blockedTurn.id;
  const turnStillWaiting = input.blockedTurn.status === "waiting_capacity";
  const terminalTurnStatus = input.session.status === "cancelled" ? "cancelled" : "superseded";
  if (turnStillWaiting) {
    const [supersededTurn] = await tx
      .update(schema.sessionTurns)
      .set({
        status: terminalTurnStatus,
        activeAttemptId: null,
        cancelledBy: "codex_capacity_reconcile",
        cancelReason: input.reason,
        version: input.blockedTurn.version + 1,
        finishedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.session.workspaceId),
          eq(schema.sessionTurns.id, input.blockedTurn.id),
          eq(schema.sessionTurns.status, "waiting_capacity"),
          isNull(schema.sessionTurns.activeAttemptId),
          eq(schema.sessionTurns.executionGeneration, input.waiter.blockedTurnGeneration),
        ),
      )
      .returning({ id: schema.sessionTurns.id });
    if (!supersededTurn) {
      throw new Error("Codex capacity blocked turn changed during atomic supersession");
    }
  }
  const [queued] = turnWasCurrent
    ? await tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, input.session.workspaceId),
            eq(schema.sessionTurns.sessionId, input.session.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        )
        .limit(1)
    : [];
  const nextSessionStatus =
    input.session.status === "cancelled" ? "cancelled" : queued ? "queued" : "idle";
  const eventValues: SessionEventInsertWithPayload[] = [
    {
      accountId: input.session.accountId,
      workspaceId: input.session.workspaceId,
      sessionId: input.session.id,
      sequence: input.session.lastSequence + 1,
      type: "codex.capacity.superseded",
      payload: {
        waiterId: updated.id,
        generation: updated.generation,
        reason: input.reason,
      },
      turnId: updated.blockedTurnId,
      turnGeneration: input.blockedTurn.executionGeneration,
      ...(turnWasCurrent ? { turnAssociation: "current" } : {}),
      occurredAt: input.now,
    },
  ];
  if (turnWasCurrent && input.session.status !== nextSessionStatus) {
    eventValues.push({
      accountId: input.session.accountId,
      workspaceId: input.session.workspaceId,
      sessionId: input.session.id,
      sequence: input.session.lastSequence + 2,
      type: "session.status.changed",
      payload: { status: nextSessionStatus, reason: input.reason },
      turnId: updated.blockedTurnId,
      turnGeneration: input.blockedTurn.executionGeneration,
      turnAssociation: "current",
      occurredAt: input.now,
    });
  }
  const inserted = await tx
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(eventValues, "payload", "payloadCodecVersion"))
    .returning();
  const lastSequence = input.session.lastSequence + inserted.length;
  const [updatedSession] = await tx
    .update(schema.sessions)
    .set({
      ...(turnWasCurrent ? { status: nextSessionStatus, activeTurnId: null } : {}),
      lastSequence,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.sessions.workspaceId, input.session.workspaceId),
        eq(schema.sessions.id, input.session.id),
        ...(turnWasCurrent ? [eq(schema.sessions.activeTurnId, input.blockedTurn.id)] : []),
      ),
    )
    .returning({ id: schema.sessions.id });
  if (!updatedSession) {
    throw new Error("Codex capacity session changed during atomic supersession");
  }
  return {
    waiter: mapCodexCapacityWaiter(updated),
    events: inserted.map(mapEvent),
  };
}

export async function reconcileCodexCapacityWait<
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    waiterId: string;
    generation: number;
    now?: Date;
    /** True only after the caller performed the due bounded metadata refresh. */
    boundedRefreshAttempted?: boolean;
  },
  decide: (
    context: CodexCapacitySelectionContext<TPolicyScope, TUnavailableDiagnostic>,
  ) => CodexCapacityAvailabilityDecision,
  policy?: {
    resolvePolicyScope?: CodexCredentialLeasePolicyScopeResolver<TPolicyScope>;
    filterNewAllocationCandidates?: CodexCredentialLeaseCandidateFilter<
      TPolicyScope,
      TUnavailableDiagnostic
    >;
  },
): Promise<ReconcileCodexCapacityWaitResult> {
  const now = input.now ?? new Date();
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await withSessionActivitySavepoint(scopedDb, async (tx) => {
        const [acceptedWaiter] = await tx
          .select({ turnId: schema.codexCapacityWaiters.blockedTurnId })
          .from(schema.codexCapacityWaiters)
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.id, input.waiterId),
            ),
          )
          .limit(1);
        const rotation = await lockExistingCodexRotationSettingsForCapacity(
          tx,
          input.workspaceId,
          acceptedWaiter?.turnId,
        );
        if (!rotation || rotation.accountId !== input.accountId) {
          return { action: "stale", waiter: null, events: [] } as const;
        }
        const prefix = await lockSessionEventWriteRows(tx, {
          workspaceId: input.workspaceId,
          controlLock: "share",
        });
        const [waiterRead] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.id, input.waiterId),
              eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
            ),
          )
          .limit(1);
        if (!waiterRead || waiterRead.generation !== input.generation) {
          return {
            action: "stale",
            waiter: waiterRead ? mapCodexCapacityWaiter(waiterRead) : null,
            events: [],
          } as const;
        }
        const locks = await lockSessionEventWriteRows(tx, {
          workspaceId: input.workspaceId,
          controlLock: "already_locked",
          workspaceLock: "already_locked",
          sessionIds: [input.sessionId],
          turnIds: [waiterRead.blockedTurnId],
        });
        const session = locks.sessions[0];
        const blockedTurn = locks.turns[0];
        const effectiveControl = session
          ? await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
              workspaceControl: prefix.control ?? undefined,
            })
          : null;
        const [goal] = waiterRead.goalId
          ? await tx
              .select()
              .from(schema.sessionGoals)
              .where(
                and(
                  eq(schema.sessionGoals.workspaceId, input.workspaceId),
                  eq(schema.sessionGoals.id, waiterRead.goalId),
                  eq(schema.sessionGoals.sessionId, input.sessionId),
                ),
              )
              .for("update")
              .limit(1)
          : [];
        const [waiter] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(eq(schema.codexCapacityWaiters.id, input.waiterId))
          .for("update")
          .limit(1);
        if (
          !session ||
          !blockedTurn ||
          !waiter ||
          session.accountId !== input.accountId ||
          blockedTurn.accountId !== input.accountId ||
          blockedTurn.sessionId !== input.sessionId ||
          waiter.accountId !== input.accountId ||
          waiter.workspaceId !== input.workspaceId ||
          waiter.sessionId !== input.sessionId ||
          waiter.blockedTurnId !== blockedTurn.id ||
          waiter.generation !== input.generation ||
          waiter.status !== "waiting"
        ) {
          return {
            action: "stale",
            waiter: waiter ? mapCodexCapacityWaiter(waiter) : null,
            events: [],
          } as const;
        }
        if (effectiveControl?.state !== "active" || effectiveControl.settlement !== null) {
          return {
            action: "paused",
            waiter: mapCodexCapacityWaiter(waiter),
            events: [],
          } as const;
        }

        const currentPolicyHash = codexCapacityPolicyHashFromTurnMetadata(blockedTurn.metadata);
        let supersedeReason: string | null = null;
        if (session.status === "cancelled") {
          supersedeReason = "session_cancelled";
        } else if (
          waiter.goalId !== null &&
          (!goal || goal.status !== "active" || goal.version !== waiter.goalVersion)
        ) {
          supersedeReason = "goal_changed";
        } else if (currentPolicyHash !== waiter.policyHash) {
          supersedeReason = "credential_policy_changed";
        } else if (session.activeTurnId !== blockedTurn.id) {
          supersedeReason = "active_turn_changed";
        } else if (session.status !== "waiting_capacity") {
          supersedeReason = "session_not_waiting_capacity";
        } else if (
          blockedTurn.status !== "waiting_capacity" ||
          blockedTurn.activeAttemptId !== null ||
          blockedTurn.executionGeneration !== waiter.blockedTurnGeneration
        ) {
          supersedeReason = "blocked_turn_changed";
        }
        if (supersedeReason) {
          const superseded = await supersedeCodexCapacityWaitInTransaction(tx, {
            session,
            blockedTurn,
            waiter,
            reason: supersedeReason,
            now,
          });
          return { action: "superseded", ...superseded } as const;
        }

        const recovery = readCodexCapacityRecovery(blockedTurn.metadata);
        // Account revisions can prompt a recheck, but cannot bypass a persisted
        // false-resumption delay. Acknowledge the wake to avoid a signal spin.
        if (recovery.retryNotBefore && Date.parse(recovery.retryNotBefore) > now.getTime()) {
          const [delayed] = await tx
            .update(schema.codexCapacityWaiters)
            .set({
              nextCheckAt: new Date(recovery.retryNotBefore),
              observedWakeRevision: waiter.wakeRevision,
              updatedAt: now,
            })
            .where(eq(schema.codexCapacityWaiters.id, waiter.id))
            .returning();
          return {
            action: "waiting",
            waiter: mapCodexCapacityWaiter(delayed!),
            events: [],
          } as const;
        }
        const acceptedCodexPolicy = readCodexCredentialPolicySnapshotV1(blockedTurn.metadata);
        const codexPolicySnapshot =
          acceptedCodexPolicy.kind === "valid" ? acceptedCodexPolicy.policy : null;
        // A post-wait source cutover must not move an already accepted turn to
        // another credential pool. The rotation lock was selected using the
        // legacy sidecar when the accepted snapshot predates its source field.
        const acceptedSource = codexPolicySnapshot?.source ?? rotation.source;
        const activeCredentialId = codexPolicySnapshot
          ? codexPolicySnapshot.activeCredentialId
          : rotation.activeCredentialId;
        const rotationEnabled = codexPolicySnapshot
          ? codexPolicySnapshot.rotationEnabled
          : rotation.rotationEnabled;
        const rotationStrategy = codexPolicySnapshot
          ? codexPolicySnapshot.rotationStrategy
          : rotation.rotationStrategy;
        const sessionPinnedCredentialId = codexPolicySnapshot
          ? codexPolicySnapshot.pinnedCredentialId
          : session.codexPinnedCredentialId;
        const sessionPinSource = codexPolicySnapshot
          ? codexPolicySnapshot.pinSource
          : ((session.codexPinSource as CodexPinSource | null) ?? null);
        const sessionLastCredentialId = codexPolicySnapshot
          ? codexPolicySnapshot.lastCredentialId
          : session.codexLastCredentialId;
        const allAccounts =
          acceptedSource === "disabled"
            ? []
            : await listCodexLeaseCandidatesInTransaction(tx, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                activeCredentialId,
                source: acceptedSource,
                excludeTurnId: waiter.blockedTurnId,
              });
        const policyScope = policy?.resolvePolicyScope?.(blockedTurn.metadata ?? {}) ?? null;
        const filtered = filterCodexLeaseCandidatesForPolicy(
          allAccounts,
          policyScope,
          policy?.filterNewAllocationCandidates,
        );
        const decision = decide({
          accounts: filtered.accounts,
          activeCredentialId,
          rotationEnabled,
          rotationStrategy,
          existingCredentialId: null,
          failedCredentialIds: unresolvedCodexCredentialFailures(
            blockedTurn.metadata,
            filtered.accounts,
            now,
          ),
          failoverExhausted: codexFailoverMetadata(blockedTurn.metadata).exhausted,
          modelId: blockedTurn.model,
          policyScope,
          unavailableDiagnostics: filtered.unavailableDiagnostics,
          sessionId: session.id,
          sessionPinnedCredentialId,
          sessionPinSource,
          sessionLastCredentialId,
          policyHash: waiter.policyHash,
        });
        if (decision.kind === "unavailable") {
          const boundedRefreshAdvanced =
            decision.resetKind === "bounded_refresh" && input.boundedRefreshAttempted === true;
          const refreshAttempt =
            decision.resetKind === "bounded_refresh"
              ? waiter.refreshAttempt + (boundedRefreshAdvanced ? 1 : 0)
              : 0;
          const nextCheckAt =
            decision.resetKind === "bounded_refresh" &&
            !boundedRefreshAdvanced &&
            waiter.resetKind === "bounded_refresh"
              ? waiter.nextCheckAt
              : nextCodexCapacityCheckAt(
                  decision.earliestResetAt,
                  decision.resetKind,
                  refreshAttempt,
                  now,
                );
          const [updated] = await tx
            .update(schema.codexCapacityWaiters)
            .set({
              earliestResetAt: decision.earliestResetAt,
              nextCheckAt,
              resetKind: decision.resetKind,
              refreshAttempt,
              observedWakeRevision: waiter.wakeRevision,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.codexCapacityWaiters.id, waiter.id),
                eq(schema.codexCapacityWaiters.status, "waiting"),
                eq(schema.codexCapacityWaiters.generation, waiter.generation),
              ),
            )
            .returning();
          if (!updated) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          return {
            action: "waiting",
            waiter: mapCodexCapacityWaiter(updated),
            events: [],
          } as const;
        }

        const events = await tx
          .insert(schema.sessionEvents)
          .values(
            withLosslessContentWriteVersion(
              [
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: session.lastSequence + 1,
                  type: "codex.capacity.resumed",
                  payload: {
                    waiterId: waiter.id,
                    generation: waiter.generation,
                    wakeRevision: waiter.wakeRevision,
                    goalId: waiter.goalId,
                    goalVersion: waiter.goalVersion,
                    blockedTurnGeneration: waiter.blockedTurnGeneration,
                    policyHash: waiter.policyHash,
                    diagnostic: decision.diagnostic ?? null,
                  },
                  turnId: blockedTurn.id,
                  turnGeneration: blockedTurn.executionGeneration,
                  turnAssociation: "current",
                  occurredAt: now,
                },
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: session.lastSequence + 2,
                  type: "session.status.changed",
                  payload: { status: "recovering", reason: "codex_capacity" },
                  turnId: blockedTurn.id,
                  turnGeneration: blockedTurn.executionGeneration,
                  turnAssociation: "current",
                  occurredAt: now,
                },
              ],
              "payload",
              "payloadCodecVersion",
            ),
          )
          .returning();
        const [updatedWaiter] = await tx
          .update(schema.codexCapacityWaiters)
          .set({
            status: "resumed",
            resumedUpdateId: null,
            observedWakeRevision: waiter.wakeRevision,
            lastWakeReason: "capacity_available",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.codexCapacityWaiters.id, waiter.id),
              eq(schema.codexCapacityWaiters.status, "waiting"),
              eq(schema.codexCapacityWaiters.generation, waiter.generation),
            ),
          )
          .returning();
        if (!updatedWaiter) {
          throw new Error("Codex capacity waiter changed during atomic resume");
        }
        const [recoveringTurn] = await tx
          .update(schema.sessionTurns)
          .set({
            status: "recovering",
            activeAttemptId: null,
            metadata: {
              ...metadataWithoutTurnDispatchAttempt(blockedTurn.metadata),
              [CODEX_CAPACITY_RECOVERY_KEY]: {
                ...recovery,
                resumeGeneration: blockedTurn.executionGeneration + 1,
              },
            },
            version: blockedTurn.version + 1,
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, blockedTurn.id),
              eq(schema.sessionTurns.status, "waiting_capacity"),
              isNull(schema.sessionTurns.activeAttemptId),
              eq(schema.sessionTurns.executionGeneration, waiter.blockedTurnGeneration),
            ),
          )
          .returning({ id: schema.sessionTurns.id });
        if (!recoveringTurn) {
          throw new Error("Codex capacity blocked turn changed during atomic resume");
        }
        const [recoveringSession] = await tx
          .update(schema.sessions)
          .set({
            status: "recovering",
            activeTurnId: blockedTurn.id,
            lastSequence: session.lastSequence + 2,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.status, "waiting_capacity"),
              eq(schema.sessions.activeTurnId, blockedTurn.id),
            ),
          )
          .returning({ id: schema.sessions.id });
        if (!recoveringSession) {
          throw new Error("Codex capacity session changed during atomic resume");
        }
        return {
          action: "resumed",
          waiter: mapCodexCapacityWaiter(updatedWaiter),
          events: events.map(mapEvent),
        } as const;
      }),
  );
}

type SubscriptionCoreCodexWaiterRow = {
  waiter_id: string;
  account_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  blocked_turn_generation: number | string | null;
  generation: number | string;
  wake_revision: number | string;
  observed_wake_revision: number | string;
  wait_reason: string;
  reset_kind: string | null;
  refresh_attempt: number | string;
  earliest_reset_at: Date | string | null;
  next_check_at: Date | string | null;
  goal_id: string | null;
  goal_version: number | string | null;
  last_wake_reason: string | null;
  updated_at: Date | string;
  blocked_turn_live?: boolean | null;
};

const SUBSCRIPTION_CORE_CODEX_WAITER_COLUMNS = sql.raw(`waiter_id::text as waiter_id,
  account_id::text as account_id, workspace_id::text as workspace_id,
  session_id::text as session_id, turn_id::text as turn_id, blocked_turn_generation,
  generation, wake_revision, observed_wake_revision, wait_reason, reset_kind,
  refresh_attempt, earliest_reset_at, next_check_at, goal_id::text as goal_id,
  goal_version, last_wake_reason, updated_at`);

function mapSubscriptionCoreCodexWaiter(
  row: SubscriptionCoreCodexWaiterRow,
): SubscriptionCoreCodexCapacityWait {
  return {
    waiterId: row.waiter_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    blockedTurnId: row.turn_id,
    blockedTurnGeneration:
      row.blocked_turn_generation === null ? null : Number(row.blocked_turn_generation),
    generation: Number(row.generation),
    wakeRevision: Number(row.wake_revision),
    observedWakeRevision: Number(row.observed_wake_revision),
    waitReason: row.wait_reason,
    resetKind: row.reset_kind,
    refreshAttempt: Number(row.refresh_attempt),
    earliestResetAt: row.earliest_reset_at === null ? null : new Date(row.earliest_reset_at),
    nextCheckAt: new Date(row.next_check_at ?? row.updated_at),
    goalId: row.goal_id,
    goalVersion: row.goal_version === null ? null : Number(row.goal_version),
    lastWakeReason: row.last_wake_reason,
    ...(row.blocked_turn_live === undefined || row.blocked_turn_live === null
      ? {}
      : { blockedTurnLive: row.blocked_turn_live }),
  };
}

async function readSubscriptionCoreCodexWaiterInTransaction(
  tx: Database,
  input: { workspaceId: string; sessionId: string; waiterId?: string; forUpdate?: boolean },
): Promise<SubscriptionCoreCodexCapacityWait | null> {
  const [row] = await rawRows<SubscriptionCoreCodexWaiterRow>(
    tx,
    sql`select ${SUBSCRIPTION_CORE_CODEX_WAITER_COLUMNS},
        exists (
          select 1 from sessions s
          join session_turns t on t.workspace_id = s.workspace_id and t.id = s.active_turn_id
          where s.workspace_id = w.workspace_id and s.id = w.session_id
            and s.active_turn_id = w.turn_id and s.status = 'waiting_capacity'
            and t.status = 'waiting_capacity'
        ) as blocked_turn_live
      from subscription_capacity_waiters w
      where workspace_id = ${input.workspaceId}::uuid and session_id = ${input.sessionId}::uuid
        and provider = 'codex'
        ${input.waiterId ? sql`and waiter_id = ${input.waiterId}::uuid` : sql``}
      ${input.forUpdate ? sql`for update` : sql``}`,
  );
  return row ? mapSubscriptionCoreCodexWaiter(row) : null;
}

async function withTemporarySubjectRls<T>(
  tx: Database,
  subjectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [prior] = await rawRows<{ subject_id: string | null }>(
    tx,
    sql`select current_setting('opengeni.subject_id', true) as subject_id`,
  );
  await setSubjectRlsContext(tx, subjectId);
  const restoreSubjectScope = async () =>
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${prior?.subject_id ?? ""}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // Restoring the scope inside an already-aborted transaction raises 25P02,
    // which would replace the real error with a useless one. Callers on the
    // claim path classify the original SQLSTATE (40P01/40001) for the
    // idempotent-persistence retry, so that substitution is not cosmetic: it
    // silently disables the retry. The transaction is unwinding here and the
    // scope dies with it, so a failed restore is moot.
    await restoreSubjectScope().catch(() => undefined);
    throw error;
  }
  // `fn` succeeded, so the transaction is still usable and the caller keeps
  // running inside it: a restore failure here is real and must surface.
  await restoreSubjectScope();
  return result;
}

function createScopedSubscriptionCapacityWaiters(options: {
  provider: "xai" | "claude";
  label: string;
  wireProvider: string;
  workerSubject: string;
  snapshotColumn: "xaiProviderAccountAuthoritySnapshot" | "claudeProviderAccountAuthoritySnapshot";
  resolvePoolFunction: "resolve_xai_authority_pool" | "resolve_claude_authority_pool";
  tables: import("../../src/subscription-pool-schema").SubscriptionPoolTables;
  rotationWorkspacePredicate: typeof xaiRotationWorkspacePredicate;
  credentialWorkspacePredicate: typeof xaiCredentialWorkspacePredicate;
  selectAvailable: typeof xaiSubscriptionRepository.selectSubscriptionCredentialForUse;
}) {
  const { tables } = options;
  function mapXaiCapacityWaiter(row: typeof tables.capacityWaiters.$inferSelect): XaiCapacityWait {
    return {
      id: row.id,
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      goalId: row.goalId,
      goalVersion: row.goalVersion,
      blockedTurnId: row.blockedTurnId,
      blockedTurnGeneration: row.blockedTurnGeneration,
      workflowId: row.workflowId,
      authorityScope: row.authorityScope as "workspace" | "user" | "organization",
      ownerOrganizationMembershipId: row.ownerOrganizationMembershipId,
      status: row.status as CodexCapacityWaitStatus,
      generation: row.generation,
      earliestResetAt: row.earliestResetAt,
      nextCheckAt: row.nextCheckAt,
      wakeRevision: row.wakeRevision,
      observedWakeRevision: row.observedWakeRevision,
      lastWakeReason: row.lastWakeReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function xaiCapacityNextCheckAt(earliestResetAt: Date | null, now: Date): Date {
    return earliestResetAt && earliestResetAt.getTime() > now.getTime()
      ? new Date(Math.min(earliestResetAt.getTime(), now.getTime() + CODEX_CAPACITY_REFRESH_MIN_MS))
      : new Date(now.getTime() + CODEX_CAPACITY_REFRESH_MIN_MS);
  }

  async function resolveXaiWaiterSubject(
    db: Database,
    workspaceId: string,
    sessionId: string,
  ): Promise<{
    subjectId: string;
    snapshot: XaiProviderAccountAuthoritySnapshotV1;
    turnId: string;
  } | null> {
    return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
      const [turn] = await scopedDb
        .select({
          id: schema.sessionTurns.id,
          initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
          snapshot: schema.sessionTurns[options.snapshotColumn],
        })
        .from(schema.sessions)
        .innerJoin(
          schema.sessionTurns,
          and(
            eq(schema.sessionTurns.workspaceId, schema.sessions.workspaceId),
            eq(schema.sessionTurns.id, schema.sessions.activeTurnId),
          ),
        )
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, sessionId),
            eq(schema.sessionTurns.sessionId, sessionId),
            eq(schema.sessionTurns.status, "waiting_capacity"),
          ),
        )
        .limit(1);
      if (!turn) return null;
      const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(turn.snapshot);
      const subjectId =
        snapshot.scope === "user" ? turn.initiatingHumanSubjectId : options.workerSubject;
      if (!subjectId) return null;
      return { subjectId, snapshot, turnId: turn.id };
    });
  }

  async function getXaiCapacityWaitForSessionInTransaction(
    tx: Database,
    workspaceId: string,
    sessionId: string,
  ): Promise<XaiCapacityWait | null> {
    const [turn] = await tx
      .select({
        id: schema.sessionTurns.id,
        initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
        snapshot: schema.sessionTurns[options.snapshotColumn],
      })
      .from(schema.sessions)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.workspaceId, schema.sessions.workspaceId),
          eq(schema.sessionTurns.id, schema.sessions.activeTurnId),
        ),
      )
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.id, sessionId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.status, "waiting_capacity"),
        ),
      )
      .limit(1);
    if (!turn) return null;
    const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(turn.snapshot);
    const subjectId =
      snapshot.scope === "user" ? turn.initiatingHumanSubjectId : options.workerSubject;
    if (!subjectId) return null;
    // The pool-worker subject must not hide the caller's own private session:
    // keep the turn's initiating human, which the caller just read itself.
    return await withTemporarySubjectRls(
      tx,
      subjectId,
      async () =>
        await withTemporaryPoolSessionAccessInTransaction(
          tx,
          subjectId === options.workerSubject ? turn.initiatingHumanSubjectId : null,
          async () => {
            const [row] = await tx
              .select()
              .from(tables.capacityWaiters)
              .where(
                and(
                  eq(tables.capacityWaiters.workspaceId, workspaceId),
                  eq(tables.capacityWaiters.sessionId, sessionId),
                  eq(tables.capacityWaiters.blockedTurnId, turn.id),
                  eq(tables.capacityWaiters.status, "waiting"),
                ),
              )
              .limit(1);
            return row ? mapXaiCapacityWaiter(row) : null;
          },
        ),
    );
  }

  async function resolveXaiPoolMembershipInTransaction(
    tx: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
    },
  ): Promise<string | null> {
    if (input.authoritySnapshot.scope !== "user") return null;
    const rows = await rawRows<{ membership_id: string }>(
      tx,
      sql`select organization_membership_id as membership_id
      from ${sql.identifier(options.resolvePoolFunction)}(
        ${input.accountId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${JSON.stringify(input.authoritySnapshot)}::jsonb
      )`,
    );
    return rows[0]?.membership_id ?? null;
  }

  function xaiSnapshotMatchesTurn(
    turn: typeof schema.sessionTurns.$inferSelect,
    snapshot: XaiProviderAccountAuthoritySnapshotV1,
    subjectId: string,
  ): boolean {
    const current = XaiProviderAccountAuthoritySnapshotV1.safeParse(turn[options.snapshotColumn]);
    return (
      current.success &&
      stableJson(current.data) === stableJson(snapshot) &&
      (snapshot.scope !== "user" || turn.initiatingHumanSubjectId === subjectId)
    );
  }

  /**
   * Open one waiter transaction. A user pool acts as its initiating human, who
   * owns any private session that runs on it. Workspace and organization pool
   * policies do not read the subject, and their synthetic worker subject would
   * make session-visibility RLS hide a member's private session (and its
   * waiter rows) from that session's own turn, so they run without one.
   */
  async function withScopedCapacityWaiterRls<T>(
    db: Database,
    workspaceId: string,
    subjectId: string,
    snapshot: XaiProviderAccountAuthoritySnapshotV1,
    fn: (db: SessionActivityDatabase) => Promise<T>,
  ): Promise<T> {
    if (!subjectId.trim()) {
      throw new Error(options.label + " capacity waiter requires a non-empty subjectId");
    }
    return snapshot.scope === "user"
      ? await withWorkspaceSubjectSessionActivityRls(db, workspaceId, subjectId, fn)
      : await withWorkspaceSessionActivityRls(db, workspaceId, fn);
  }

  /**
   * Atomically close one exact xAI attempt and preserve its logical turn behind a
   * durable provider-capacity waiter. The immutable authority snapshot and, for
   * private pools, exact initiating human are revalidated under FORCE RLS before
   * any session/turn projection changes.
   */
  async function armXaiCapacityWait(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      subjectId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      workflowId: string;
      authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
      goalId?: string | null;
      goalVersion?: number | null;
      earliestResetAt: Date | null;
      failurePayload: Record<string, unknown>;
      leaseFence?: { holderId: string; generation: number };
      credentialQuarantine?: XaiCredentialLeaseQuarantine;
      expectedCredentialVersion?: number;
      credentialTokenFence?: { encryptionKey: Uint8Array; observedAccessToken: string };
      now?: Date;
    },
  ): Promise<ArmXaiCapacityWaitResult> {
    const now = input.now ?? new Date();
    const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(input.authoritySnapshot);
    const goalId = input.goalId ?? null;
    const goalVersion = input.goalVersion ?? null;
    if (
      (goalId === null) !== (goalVersion === null) ||
      (goalVersion !== null && (!Number.isSafeInteger(goalVersion) || goalVersion < 1))
    ) {
      throw new Error(
        options.label + " capacity goal fence must be absent or contain a positive version",
      );
    }
    if (input.credentialQuarantine && !input.leaseFence) {
      throw new Error(options.label + " credential quarantine requires an exact lease fence");
    }
    if (options.provider === "claude" && input.credentialQuarantine && !input.credentialTokenFence)
      throw new Error("Claude credential quarantine requires the exact dispatched token");
    if (
      input.credentialQuarantine?.kind === "cooldown" &&
      (!Number.isFinite(input.credentialQuarantine.until.getTime()) ||
        input.credentialQuarantine.until.getTime() <= now.getTime())
    ) {
      throw new Error(options.label + " credential cooldown must end in the future");
    }
    return await withScopedCapacityWaiterRls(
      db,
      input.workspaceId,
      input.subjectId,
      snapshot,
      async (scopedDb) =>
        await withSessionActivitySavepoint(scopedDb, async (tx) => {
          const ownerOrganizationMembershipId = await resolveXaiPoolMembershipInTransaction(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            authoritySnapshot: snapshot,
          });
          if (snapshot.scope === "user" && !ownerOrganizationMembershipId) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          if (snapshot.scope !== "organization")
            await tx
              .insert(tables.rotationSettings)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: snapshot.scope,
                ownerOrganizationMembershipId,
              })
              .onConflictDoNothing();
          const [rotation] = await tx
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                options.rotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, snapshot.scope),
                ownerOrganizationMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(
                      tables.rotationSettings.ownerOrganizationMembershipId,
                      ownerOrganizationMembershipId,
                    ),
              ),
            )
            .for("update")
            .limit(1);
          if (!rotation || rotation.accountId !== input.accountId) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          // Child-lifecycle prefix: the parent session is locked with the child
          // so the capacity-wait notice can be enqueued in this same commit.
          const locks = await lockChildLifecycleOutboxWriteRowsTx(tx, input.workspaceId, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
          });
          const session = locks.session;
          const turn = locks.turns[0];
          const attempt = locks.attempts[0];
          const effectiveControl = session
            ? await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
                workspaceControl: locks.control ?? undefined,
              })
            : null;
          const [goal] = goalId
            ? await tx
                .select()
                .from(schema.sessionGoals)
                .where(
                  and(
                    eq(schema.sessionGoals.workspaceId, input.workspaceId),
                    eq(schema.sessionGoals.id, goalId),
                    eq(schema.sessionGoals.sessionId, input.sessionId),
                  ),
                )
                .for("update")
                .limit(1)
            : [];
          const [lease] = input.leaseFence
            ? await tx
                .select()
                .from(tables.credentialLeases)
                .where(
                  and(
                    eq(tables.credentialLeases.workspaceId, input.workspaceId),
                    eq(tables.credentialLeases.turnId, input.turnId),
                  ),
                )
                .for("update")
                .limit(1)
            : [];
          const [existing] = await tx
            .select()
            .from(tables.capacityWaiters)
            .where(
              and(
                eq(tables.capacityWaiters.workspaceId, input.workspaceId),
                eq(tables.capacityWaiters.sessionId, input.sessionId),
                eq(tables.capacityWaiters.authorityScope, snapshot.scope),
                ownerOrganizationMembershipId === null
                  ? isNull(tables.capacityWaiters.ownerOrganizationMembershipId)
                  : eq(
                      tables.capacityWaiters.ownerOrganizationMembershipId,
                      ownerOrganizationMembershipId,
                    ),
              ),
            )
            .for("update")
            .limit(1);
          const exactRowsMatch =
            session?.accountId === input.accountId &&
            turn?.accountId === input.accountId &&
            turn?.sessionId === input.sessionId &&
            attempt?.accountId === input.accountId &&
            attempt?.sessionId === input.sessionId &&
            attempt?.turnId === input.turnId;
          if (!exactRowsMatch || !turn) {
            return {
              action: "stale",
              waiter: existing ? mapXaiCapacityWaiter(existing) : null,
              events: [],
            } as const;
          }
          if (
            existing?.status === "waiting" &&
            existing.blockedTurnId === input.turnId &&
            existing.blockedTurnGeneration === turn.executionGeneration &&
            turn.status === "waiting_capacity" &&
            session?.status === "waiting_capacity" &&
            session.activeTurnId === input.turnId
          ) {
            return {
              action: "waiting",
              waiter: mapXaiCapacityWaiter(existing),
              events: [],
            } as const;
          }
          const leaseFenceValid =
            !input.leaseFence ||
            (lease?.accountId === input.accountId &&
              lease.workspaceId === input.workspaceId &&
              lease.authorityScope === snapshot.scope &&
              lease.ownerOrganizationMembershipId === ownerOrganizationMembershipId &&
              lease.holderId === input.leaseFence.holderId &&
              lease.generation === input.leaseFence.generation);
          const leaseStillLive = async () => {
            if (!input.leaseFence) return true;
            if (!lease) return false;
            const [clock] = await rawRows<{ live: boolean }>(
              tx,
              sql`select ${lease.leasedUntil.toISOString()}::timestamptz > clock_timestamp() as live`,
            );
            return clock?.live === true;
          };
          if (
            !session ||
            !attempt ||
            effectiveControl?.state !== "active" ||
            effectiveControl.settlement !== null ||
            session.activeTurnId !== input.turnId ||
            session.status !== "running" ||
            turn.status !== "running" ||
            turn.activeAttemptId !== input.attemptId ||
            (goalId !== null &&
              (!goal || goal.status !== "active" || goal.version !== goalVersion)) ||
            !leaseFenceValid ||
            !(await leaseStillLive()) ||
            !xaiSnapshotMatchesTurn(turn, snapshot, input.subjectId)
          ) {
            return {
              action: "stale",
              waiter: existing ? mapXaiCapacityWaiter(existing) : null,
              events: [],
            } as const;
          }

          if (input.credentialQuarantine) {
            if (!lease)
              throw new Error(options.label + " credential quarantine lost its lease fence");
            const [credential] = await tx
              .select({ encrypted: tables.credentials.credentialEncrypted })
              .from(tables.credentials)
              .where(
                and(
                  eq(tables.credentials.accountId, input.accountId),
                  eq(tables.credentials.id, lease.credentialId),
                ),
              )
              .for("update")
              .limit(1);
            if (!credential || !(await leaseStillLive()))
              return {
                action: "stale",
                waiter: existing ? mapXaiCapacityWaiter(existing) : null,
                events: [],
              } as const;
            if (options.provider === "claude" && input.credentialTokenFence) {
              const fence = input.credentialTokenFence;
              const token = credential
                ? ClaudeSubscriptionCredential.parse(
                    JSON.parse(decryptEnvironmentValue(fence.encryptionKey, credential.encrypted)),
                  ).token
                : null;
              const current = Buffer.from(token ?? ""),
                observed = Buffer.from(fence.observedAccessToken);
              if (
                !token ||
                current.length !== observed.length ||
                !timingSafeEqual(current, observed)
              )
                return {
                  action: "stale",
                  waiter: existing ? mapXaiCapacityWaiter(existing) : null,
                  events: [],
                } as const;
            }
            const updated = await tx
              .update(tables.credentials)
              .set(
                input.credentialQuarantine.kind === "status"
                  ? {
                      status: input.credentialQuarantine.status,
                      lastError: input.credentialQuarantine.lastError,
                      exhaustedUntil: null,
                      updatedAt: now,
                    }
                  : {
                      exhaustedUntil: input.credentialQuarantine.until,
                      updatedAt: now,
                    },
              )
              .where(
                and(
                  eq(tables.credentials.accountId, input.accountId),
                  options.credentialWorkspacePredicate(input.workspaceId),
                  eq(tables.credentials.id, lease.credentialId),
                  sql`${lease.leasedUntil.toISOString()}::timestamptz > clock_timestamp()`,
                  ...(input.expectedCredentialVersion === undefined
                    ? []
                    : [eq(tables.credentials.version, input.expectedCredentialVersion)]),
                ),
              )
              .returning({ id: tables.credentials.id });
            if (updated.length !== 1) {
              if (input.leaseFence)
                return {
                  action: "stale",
                  waiter: existing ? mapXaiCapacityWaiter(existing) : null,
                  events: [],
                } as const;
              throw new Error(options.label + " credential quarantine lost its credential fence");
            }
          }

          await closeSessionTurnAttemptInTransaction(tx, {
            id: input.attemptId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            executionGeneration: turn.executionGeneration,
            outcome: "waiting_capacity",
            closedAt: now,
          });
          const generation = (existing?.generation ?? 0) + 1;
          const wakeRevision = (existing?.wakeRevision ?? 0) + 1;
          const nextCheckAt = xaiCapacityNextCheckAt(input.earliestResetAt, now);
          const values = {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            goalId,
            goalVersion,
            blockedTurnId: input.turnId,
            blockedTurnGeneration: turn.executionGeneration,
            workflowId: input.workflowId,
            authorityScope: snapshot.scope,
            ownerOrganizationMembershipId,
            status: "waiting",
            generation,
            earliestResetAt: input.earliestResetAt,
            nextCheckAt,
            wakeRevision,
            observedWakeRevision: wakeRevision,
            lastWakeReason: "capacity_wait_armed",
            updatedAt: now,
          } as const;
          const [waiterRow] = existing
            ? await tx
                .update(tables.capacityWaiters)
                .set(values)
                .where(eq(tables.capacityWaiters.id, existing.id))
                .returning()
            : await tx.insert(tables.capacityWaiters).values(values).returning();
          if (!waiterRow)
            throw new Error(options.label + " capacity wait arm returned no waiter row");

          let sequence = session.lastSequence;
          const closedTools = await closePendingSessionToolCallsInTransaction(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: options.provider + "_capacity_wait",
            sequence,
            now,
            preserveInterruptionRows: true,
          });
          sequence = closedTools.sequence;
          const inserted = await tx
            .insert(schema.sessionEvents)
            .values(
              withLosslessContentWriteVersion(
                [
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: ++sequence,
                    type: "turn.capacity_waiting",
                    payload: {
                      ...input.failurePayload,
                      provider: options.wireProvider,
                      recovery: "provider_capacity",
                      retryable: true,
                      waiterId: waiterRow.id,
                      generation: waiterRow.generation,
                      goalId,
                      goalVersion,
                      blockedTurnGeneration: turn.executionGeneration,
                      earliestResetAt: input.earliestResetAt?.toISOString() ?? null,
                      nextCheckAt: nextCheckAt.toISOString(),
                    },
                    turnId: input.turnId,
                    turnGeneration: turn.executionGeneration,
                    turnAttemptId: input.attemptId,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: ++sequence,
                    type: "session.status.changed",
                    payload: {
                      status: "waiting_capacity",
                      reason: options.provider + "_capacity",
                    },
                    turnId: input.turnId,
                    turnGeneration: turn.executionGeneration,
                    turnAttemptId: input.attemptId,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                ],
                "payload",
                "payloadCodecVersion",
              ),
            )
            .returning();
          const [waitingTurn] = await tx
            .update(schema.sessionTurns)
            .set({
              status: "waiting_capacity",
              activeAttemptId: null,
              metadata: metadataWithoutTurnDispatchAttempt(turn.metadata),
              version: turn.version + 1,
              finishedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, input.workspaceId),
                eq(schema.sessionTurns.id, input.turnId),
                eq(schema.sessionTurns.status, "running"),
                eq(schema.sessionTurns.activeAttemptId, input.attemptId),
              ),
            )
            .returning({ id: schema.sessionTurns.id });
          if (!waitingTurn)
            throw new Error(options.label + " capacity blocked turn changed during atomic arm");
          const [waitingSession] = await tx
            .update(schema.sessions)
            .set({
              status: "waiting_capacity",
              activeTurnId: input.turnId,
              lastSequence: sequence,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessions.workspaceId, input.workspaceId),
                eq(schema.sessions.id, input.sessionId),
                eq(schema.sessions.status, "running"),
                eq(schema.sessions.activeTurnId, input.turnId),
              ),
            )
            .returning({ id: schema.sessions.id });
          if (!waitingSession)
            throw new Error(options.label + " capacity session changed during atomic arm");
          await enqueueChildWaitingCapacityOutboxTx(tx, input.workspaceId, session, {
            turnId: input.turnId,
            waiterId: waiterRow.id,
            provider: options.provider,
            nextCheckAt,
          });
          if (input.leaseFence) {
            await tx
              .delete(tables.credentialLeases)
              .where(
                and(
                  eq(tables.credentialLeases.workspaceId, input.workspaceId),
                  eq(tables.credentialLeases.turnId, input.turnId),
                  eq(tables.credentialLeases.holderId, input.leaseFence.holderId),
                  eq(tables.credentialLeases.generation, input.leaseFence.generation),
                ),
              );
          }
          return {
            action: "waiting",
            waiter: mapXaiCapacityWaiter(waiterRow),
            events: [...closedTools.events, ...inserted.map(mapEvent)],
          } as const;
        }),
    );
  }

  async function getXaiCapacityWaitForSession(
    db: Database,
    workspaceId: string,
    sessionId: string,
  ): Promise<XaiCapacityWait | null> {
    const authority = await resolveXaiWaiterSubject(db, workspaceId, sessionId);
    if (!authority) return null;
    return await withSubscriptionPoolSessionAccess(
      db,
      { workspaceId, subjectId: authority.subjectId, sessionId, turnId: authority.turnId },
      async () =>
        await withWorkspaceSubjectRls(db, workspaceId, authority.subjectId, async (scopedDb) => {
          const [row] = await scopedDb
            .select()
            .from(tables.capacityWaiters)
            .where(
              and(
                eq(tables.capacityWaiters.workspaceId, workspaceId),
                eq(tables.capacityWaiters.sessionId, sessionId),
                eq(tables.capacityWaiters.blockedTurnId, authority.turnId),
                eq(tables.capacityWaiters.status, "waiting"),
              ),
            )
            .limit(1);
          return row ? mapXaiCapacityWaiter(row) : null;
        }),
    );
  }

  async function supersedeXaiCapacityWaitInTransaction(
    tx: SessionActivityDatabase,
    input: {
      session: typeof schema.sessions.$inferSelect;
      blockedTurn: typeof schema.sessionTurns.$inferSelect;
      waiter: typeof tables.capacityWaiters.$inferSelect;
      reason: string;
      now: Date;
    },
  ): Promise<{ waiter: XaiCapacityWait; events: SessionEvent[] }> {
    const [updated] = await tx
      .update(tables.capacityWaiters)
      .set({
        status: "superseded",
        observedWakeRevision: input.waiter.wakeRevision,
        lastWakeReason: input.reason,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tables.capacityWaiters.id, input.waiter.id),
          eq(tables.capacityWaiters.status, "waiting"),
        ),
      )
      .returning();
    if (!updated) return { waiter: mapXaiCapacityWaiter(input.waiter), events: [] };
    const turnWasCurrent = input.session.activeTurnId === input.blockedTurn.id;
    const terminalTurnStatus = input.session.status === "cancelled" ? "cancelled" : "superseded";
    if (input.blockedTurn.status === "waiting_capacity") {
      const [settledTurn] = await tx
        .update(schema.sessionTurns)
        .set({
          status: terminalTurnStatus,
          activeAttemptId: null,
          cancelledBy: options.provider + "_capacity_reconcile",
          cancelReason: input.reason,
          version: input.blockedTurn.version + 1,
          finishedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, input.session.workspaceId),
            eq(schema.sessionTurns.id, input.blockedTurn.id),
            eq(schema.sessionTurns.status, "waiting_capacity"),
            isNull(schema.sessionTurns.activeAttemptId),
            eq(schema.sessionTurns.executionGeneration, input.waiter.blockedTurnGeneration),
          ),
        )
        .returning({ id: schema.sessionTurns.id });
      if (!settledTurn)
        throw new Error(options.label + " capacity blocked turn changed during supersession");
    }
    const [queued] = turnWasCurrent
      ? await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.session.workspaceId),
              eq(schema.sessionTurns.sessionId, input.session.id),
              eq(schema.sessionTurns.status, "queued"),
            ),
          )
          .limit(1)
      : [];
    const nextSessionStatus =
      input.session.status === "cancelled" ? "cancelled" : queued ? "queued" : "idle";
    const values: SessionEventInsertWithPayload[] = [
      {
        accountId: input.session.accountId,
        workspaceId: input.session.workspaceId,
        sessionId: input.session.id,
        sequence: input.session.lastSequence + 1,
        type: "turn.superseded",
        payload: {
          provider: options.wireProvider,
          waiterId: updated.id,
          generation: updated.generation,
          reason: input.reason,
        },
        turnId: updated.blockedTurnId,
        turnGeneration: input.blockedTurn.executionGeneration,
        ...(turnWasCurrent ? { turnAssociation: "current" as const } : {}),
        occurredAt: input.now,
      },
    ];
    if (turnWasCurrent && input.session.status !== nextSessionStatus) {
      values.push({
        accountId: input.session.accountId,
        workspaceId: input.session.workspaceId,
        sessionId: input.session.id,
        sequence: input.session.lastSequence + 2,
        type: "session.status.changed",
        payload: { status: nextSessionStatus, reason: input.reason },
        turnId: updated.blockedTurnId,
        turnGeneration: input.blockedTurn.executionGeneration,
        turnAssociation: "current",
        occurredAt: input.now,
      });
    }
    const inserted = await tx
      .insert(schema.sessionEvents)
      .values(withLosslessContentWriteVersion(values, "payload", "payloadCodecVersion"))
      .returning();
    const [updatedSession] = await tx
      .update(schema.sessions)
      .set({
        ...(turnWasCurrent ? { status: nextSessionStatus, activeTurnId: null } : {}),
        lastSequence: input.session.lastSequence + inserted.length,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.session.workspaceId),
          eq(schema.sessions.id, input.session.id),
          ...(turnWasCurrent ? [eq(schema.sessions.activeTurnId, input.blockedTurn.id)] : []),
        ),
      )
      .returning({ id: schema.sessions.id });
    if (!updatedSession)
      throw new Error(options.label + " capacity session changed during supersession");
    return {
      waiter: mapXaiCapacityWaiter(updated),
      events: inserted.map(mapEvent),
    };
  }

  async function reconcileXaiCapacityWait(
    db: Database,
    input: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      waiterId: string;
      generation: number;
      now?: Date;
    },
  ): Promise<ReconcileXaiCapacityWaitResult> {
    const now = input.now ?? new Date();
    const authority = await resolveXaiWaiterSubject(db, input.workspaceId, input.sessionId);
    if (!authority) return { action: "stale", waiter: null, events: [] };
    return await withScopedCapacityWaiterRls(
      db,
      input.workspaceId,
      authority.subjectId,
      authority.snapshot,
      async (scopedDb) =>
        await withSessionActivitySavepoint(scopedDb, async (tx) => {
          const ownerOrganizationMembershipId = await resolveXaiPoolMembershipInTransaction(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: authority.subjectId,
            authoritySnapshot: authority.snapshot,
          });
          if (authority.snapshot.scope === "user" && !ownerOrganizationMembershipId) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          const [rotation] = await tx
            .select()
            .from(tables.rotationSettings)
            .where(
              and(
                options.rotationWorkspacePredicate(input.workspaceId),
                eq(tables.rotationSettings.authorityScope, authority.snapshot.scope),
                ownerOrganizationMembershipId === null
                  ? isNull(tables.rotationSettings.ownerOrganizationMembershipId)
                  : eq(
                      tables.rotationSettings.ownerOrganizationMembershipId,
                      ownerOrganizationMembershipId,
                    ),
              ),
            )
            .for("update")
            .limit(1);
          if (!rotation || rotation.accountId !== input.accountId) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          const prefix = await lockSessionEventWriteRows(tx, {
            workspaceId: input.workspaceId,
            controlLock: "share",
          });
          const [waiterRead] = await tx
            .select()
            .from(tables.capacityWaiters)
            .where(
              and(
                eq(tables.capacityWaiters.workspaceId, input.workspaceId),
                eq(tables.capacityWaiters.id, input.waiterId),
                eq(tables.capacityWaiters.sessionId, input.sessionId),
              ),
            )
            .limit(1);
          if (!waiterRead || waiterRead.generation !== input.generation) {
            return {
              action: "stale",
              waiter: waiterRead ? mapXaiCapacityWaiter(waiterRead) : null,
              events: [],
            } as const;
          }
          const locks = await lockSessionEventWriteRows(tx, {
            workspaceId: input.workspaceId,
            controlLock: "already_locked",
            workspaceLock: "already_locked",
            sessionIds: [input.sessionId],
            turnIds: [waiterRead.blockedTurnId],
          });
          const session = locks.sessions[0];
          const blockedTurn = locks.turns[0];
          const effectiveControl = session
            ? await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
                workspaceControl: prefix.control ?? undefined,
              })
            : null;
          const [goal] = waiterRead.goalId
            ? await tx
                .select()
                .from(schema.sessionGoals)
                .where(
                  and(
                    eq(schema.sessionGoals.workspaceId, input.workspaceId),
                    eq(schema.sessionGoals.id, waiterRead.goalId),
                    eq(schema.sessionGoals.sessionId, input.sessionId),
                  ),
                )
                .for("update")
                .limit(1)
            : [];
          const [waiter] = await tx
            .select()
            .from(tables.capacityWaiters)
            .where(eq(tables.capacityWaiters.id, input.waiterId))
            .for("update")
            .limit(1);
          if (
            !session ||
            !blockedTurn ||
            !waiter ||
            session.accountId !== input.accountId ||
            blockedTurn.accountId !== input.accountId ||
            blockedTurn.sessionId !== input.sessionId ||
            waiter.accountId !== input.accountId ||
            waiter.workspaceId !== input.workspaceId ||
            waiter.sessionId !== input.sessionId ||
            waiter.blockedTurnId !== blockedTurn.id ||
            waiter.generation !== input.generation ||
            waiter.status !== "waiting"
          ) {
            return {
              action: "stale",
              waiter: waiter ? mapXaiCapacityWaiter(waiter) : null,
              events: [],
            } as const;
          }
          if (effectiveControl?.state !== "active" || effectiveControl.settlement !== null) {
            return {
              action: "paused",
              waiter: mapXaiCapacityWaiter(waiter),
              events: [],
            } as const;
          }
          let supersedeReason: string | null = null;
          if (session.status === "cancelled") {
            supersedeReason = "session_cancelled";
          } else if (
            waiter.goalId !== null &&
            (!goal || goal.status !== "active" || goal.version !== waiter.goalVersion)
          ) {
            supersedeReason = "goal_changed";
          } else if (
            !xaiSnapshotMatchesTurn(blockedTurn, authority.snapshot, authority.subjectId)
          ) {
            supersedeReason = "provider_authority_changed";
          } else if (
            waiter.authorityScope !== authority.snapshot.scope ||
            waiter.ownerOrganizationMembershipId !== ownerOrganizationMembershipId
          ) {
            supersedeReason = "provider_authority_pool_changed";
          } else if (session.activeTurnId !== blockedTurn.id) {
            supersedeReason = "active_turn_changed";
          } else if (session.status !== "waiting_capacity") {
            supersedeReason = "session_not_waiting_capacity";
          } else if (
            blockedTurn.status !== "waiting_capacity" ||
            blockedTurn.activeAttemptId !== null ||
            blockedTurn.executionGeneration !== waiter.blockedTurnGeneration
          ) {
            supersedeReason = "blocked_turn_changed";
          }
          if (supersedeReason) {
            const superseded = await supersedeXaiCapacityWaitInTransaction(tx, {
              session,
              blockedTurn,
              waiter,
              reason: supersedeReason,
              now,
            });
            return { action: "superseded", ...superseded } as const;
          }

          await tx
            .delete(tables.credentialLeases)
            .where(
              and(
                eq(tables.credentialLeases.workspaceId, input.workspaceId),
                lte(tables.credentialLeases.leasedUntil, now),
              ),
            );
          const [pin] = await tx
            .select()
            .from(tables.sessionAccountPins)
            .where(
              and(
                eq(tables.sessionAccountPins.workspaceId, input.workspaceId),
                eq(tables.sessionAccountPins.sessionId, input.sessionId),
                eq(tables.sessionAccountPins.authorityScope, authority.snapshot.scope),
                ownerOrganizationMembershipId === null
                  ? isNull(tables.sessionAccountPins.ownerOrganizationMembershipId)
                  : eq(
                      tables.sessionAccountPins.ownerOrganizationMembershipId,
                      ownerOrganizationMembershipId,
                    ),
              ),
            )
            .limit(1);
          const policy = readTurnExecutionPolicyV1(blockedTurn.metadata);
          if (options.provider === "claude" && policy.kind !== "valid")
            throw new Error("Claude capacity reconciliation requires its accepted model policy");
          const selection = await options.selectAvailable(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: authority.subjectId,
            authoritySnapshot: authority.snapshot,
            shardKey: input.sessionId,
            modelId: policy.kind === "valid" ? policy.policy.productModelId : blockedTurn.model,
            ...(policy.kind === "valid" ? { upstreamModelId: policy.policy.upstreamModelId } : {}),
            pinnedCredentialId: pin?.pinnedCredentialId ?? null,
            pinSource:
              pin?.pinSource === "manual" || pin?.pinSource === "policy" ? pin.pinSource : null,
            now,
          });
          const selected = selection.credentialId;
          if (!selected) {
            const earliestResetAt = selection.nextCheckAt ?? null;
            const [updated] = await tx
              .update(tables.capacityWaiters)
              .set({
                earliestResetAt,
                nextCheckAt: xaiCapacityNextCheckAt(earliestResetAt, now),
                observedWakeRevision: waiter.wakeRevision,
                updatedAt: now,
              })
              .where(
                and(
                  eq(tables.capacityWaiters.id, waiter.id),
                  eq(tables.capacityWaiters.status, "waiting"),
                  eq(tables.capacityWaiters.generation, waiter.generation),
                ),
              )
              .returning();
            if (!updated) return { action: "stale", waiter: null, events: [] } as const;
            return {
              action: "waiting",
              waiter: mapXaiCapacityWaiter(updated),
              events: [],
            } as const;
          }

          const inserted = await tx
            .insert(schema.sessionEvents)
            .values(
              withLosslessContentWriteVersion(
                [
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: session.lastSequence + 1,
                    type: "turn.recovery.requested",
                    payload: {
                      reason: options.provider + "_capacity_available",
                      provider: options.wireProvider,
                      waiterId: waiter.id,
                      generation: waiter.generation,
                      wakeRevision: waiter.wakeRevision,
                    },
                    turnId: blockedTurn.id,
                    turnGeneration: blockedTurn.executionGeneration,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: session.lastSequence + 2,
                    type: "session.status.changed",
                    payload: { status: "recovering", reason: options.provider + "_capacity" },
                    turnId: blockedTurn.id,
                    turnGeneration: blockedTurn.executionGeneration,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                ],
                "payload",
                "payloadCodecVersion",
              ),
            )
            .returning();
          const [updatedWaiter] = await tx
            .update(tables.capacityWaiters)
            .set({
              status: "resumed",
              observedWakeRevision: waiter.wakeRevision,
              lastWakeReason: "capacity_available",
              updatedAt: now,
            })
            .where(
              and(
                eq(tables.capacityWaiters.id, waiter.id),
                eq(tables.capacityWaiters.status, "waiting"),
                eq(tables.capacityWaiters.generation, waiter.generation),
              ),
            )
            .returning();
          if (!updatedWaiter)
            throw new Error(options.label + " capacity waiter changed during atomic resume");
          const [recoveringTurn] = await tx
            .update(schema.sessionTurns)
            .set({
              status: "recovering",
              activeAttemptId: null,
              metadata: metadataWithoutTurnDispatchAttempt(blockedTurn.metadata),
              version: blockedTurn.version + 1,
              finishedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, input.workspaceId),
                eq(schema.sessionTurns.id, blockedTurn.id),
                eq(schema.sessionTurns.status, "waiting_capacity"),
                isNull(schema.sessionTurns.activeAttemptId),
                eq(schema.sessionTurns.executionGeneration, waiter.blockedTurnGeneration),
              ),
            )
            .returning({ id: schema.sessionTurns.id });
          if (!recoveringTurn)
            throw new Error(options.label + " capacity blocked turn changed during resume");
          const [recoveringSession] = await tx
            .update(schema.sessions)
            .set({
              status: "recovering",
              activeTurnId: blockedTurn.id,
              lastSequence: session.lastSequence + 2,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessions.workspaceId, input.workspaceId),
                eq(schema.sessions.id, input.sessionId),
                eq(schema.sessions.status, "waiting_capacity"),
                eq(schema.sessions.activeTurnId, blockedTurn.id),
              ),
            )
            .returning({ id: schema.sessions.id });
          if (!recoveringSession)
            throw new Error(options.label + " capacity session changed during resume");
          return {
            action: "resumed",
            waiter: mapXaiCapacityWaiter(updatedWaiter),
            events: inserted.map(mapEvent),
          } as const;
        }),
    );
  }

  return {
    resolveWaiterSubject: resolveXaiWaiterSubject,
    getWaitForSessionInTransaction: getXaiCapacityWaitForSessionInTransaction,
    armCapacityWait: armXaiCapacityWait,
    getWaitForSession: getXaiCapacityWaitForSession,
    reconcileCapacityWait: reconcileXaiCapacityWait,
  };
}

const xaiCapacityRepository = createScopedSubscriptionCapacityWaiters({
  provider: "xai",
  label: "SuperGrok",
  wireProvider: "supergrok-subscription",
  workerSubject: subscriptionPoolWorkerSubject("xai"),
  snapshotColumn: "xaiProviderAccountAuthoritySnapshot",
  resolvePoolFunction: "resolve_xai_authority_pool",
  tables: {
    credentials: schema.xaiSubscriptionCredentials,
    rotationSettings: schema.xaiRotationSettings,
    credentialLeases: schema.xaiCredentialLeases,
    sessionAccountPins: schema.xaiSessionAccountPins,
    capacityWaiters: schema.xaiCapacityWaiters,
  },
  rotationWorkspacePredicate: xaiRotationWorkspacePredicate,
  credentialWorkspacePredicate: xaiCredentialWorkspacePredicate,
  selectAvailable: xaiSubscriptionRepository.selectSubscriptionCredentialForUse,
});

const claudeCapacityRepository = createScopedSubscriptionCapacityWaiters({
  provider: "claude",
  label: "Claude",
  wireProvider: "claude-subscription",
  workerSubject: subscriptionPoolWorkerSubject("claude"),
  snapshotColumn: "claudeProviderAccountAuthoritySnapshot",
  resolvePoolFunction: "resolve_claude_authority_pool",
  tables: claudeSubscriptionTables,
  rotationWorkspacePredicate:
    claudeSubscriptionAccountRepository.subscriptionRotationWorkspacePredicate,
  credentialWorkspacePredicate:
    claudeSubscriptionAccountRepository.subscriptionCredentialWorkspacePredicate,
  selectAvailable: claudeSubscriptionAccountRepository.selectSubscriptionCredentialForUse,
});

const getXaiCapacityWaitForSessionInTransaction =
  xaiCapacityRepository.getWaitForSessionInTransaction;

const getClaudeCapacityWaitForSessionInTransaction =
  claudeCapacityRepository.getWaitForSessionInTransaction;

export async function heartbeatCodexCredentialLeaseUntil(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
  leaseTtlMs: number = CODEX_CREDENTIAL_LEASE_TTL_MS,
): Promise<Date | null> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    return heartbeatSubscriptionCredentialLeaseUntil(scopedDb, "codex_credential_leases", {
      workspaceId,
      turnId,
      holderId,
      generation,
      ttlMs: leaseTtlMs,
    });
  });
}

export async function heartbeatCodexCredentialLease(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
  leaseTtlMs: number = CODEX_CREDENTIAL_LEASE_TTL_MS,
): Promise<boolean> {
  return (
    (await heartbeatCodexCredentialLeaseUntil(
      db,
      accountId,
      workspaceId,
      turnId,
      holderId,
      generation,
      leaseTtlMs,
    )) !== null
  );
}

export async function releaseCodexCredentialLease(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
): Promise<boolean> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.codexCredentialLeases)
      .where(
        and(
          eq(schema.codexCredentialLeases.workspaceId, workspaceId),
          eq(schema.codexCredentialLeases.turnId, turnId),
          eq(schema.codexCredentialLeases.holderId, holderId),
          eq(schema.codexCredentialLeases.generation, generation),
        ),
      )
      .returning({ id: schema.codexCredentialLeases.id });
    return rows.length > 0;
  });
}

export async function quarantineCodexCredentialForLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    workflowId: string;
    workflowRunId: string;
    dispatchId: string;
    expectedRedispatches: number;
    credentialId: string;
    credentialVersion: number;
    holderId: string;
    generation: number;
    maxFailovers: number;
    quarantine: CodexCredentialLeaseQuarantine;
  },
): Promise<CodexCredentialLeaseQuarantineResult> {
  if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1) {
    throw new Error("Codex quarantine credential version must be positive");
  }
  if (!Number.isSafeInteger(input.maxFailovers) || input.maxFailovers < 1) {
    throw new Error("Codex quarantine failover bound must be positive");
  }
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const locks = await lockSessionEventWriteRows(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          controlLock: "share",
          sessionIds: [input.sessionId],
          turnIds: [input.turnId],
          attemptIds: [input.attemptId],
        });
        const session = locks.sessions[0];
        const turn = locks.turns[0];
        const attempt = locks.attempts[0];
        const metadata = codexFailoverMetadata(turn?.metadata);
        const maxFailovers = metadata.maxFailovers ?? input.maxFailovers;
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        const dispatch = readTurnDispatchMetadata(turn?.metadata);
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { workspaceControl: locks.control ?? undefined },
        );
        if (
          !locks.workspace ||
          !session ||
          !turn ||
          !attempt ||
          session.accountId !== input.accountId ||
          session.activeTurnId !== input.turnId ||
          session.status !== "running" ||
          turn.accountId !== input.accountId ||
          turn.sessionId !== input.sessionId ||
          turn.status !== "running" ||
          turn.activeAttemptId !== input.attemptId ||
          turn.executionGeneration !== input.executionGeneration ||
          attempt.accountId !== input.accountId ||
          attempt.sessionId !== input.sessionId ||
          attempt.turnId !== input.turnId ||
          (attempt.state !== "claimed" && attempt.state !== "running") ||
          attempt.executionGeneration !== input.executionGeneration ||
          attempt.temporalWorkflowId !== input.workflowId ||
          attempt.temporalWorkflowRunId !== input.workflowRunId ||
          attempt.temporalActivityId !== input.dispatchId ||
          dispatch.kind !== "valid" ||
          dispatch.attempt?.id !== input.dispatchId ||
          currentRedispatches !== input.expectedRedispatches ||
          effectiveControl.state !== "active"
        ) {
          return {
            action: "stale",
            failoverCount: metadata.failoverCount,
            maxFailovers,
          } as const;
        }
        const leaseRows = await tx.execute(sql<{ id: string }>`
          select id from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and credential_id = ${input.credentialId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
            and leased_until > clock_timestamp()
          for update
        `);
        if (!leaseRows[0]) {
          return {
            action: "stale",
            failoverCount: metadata.failoverCount,
            maxFailovers,
          } as const;
        }
        const condition = await codexCredentialUseCondition(tx, input.workspaceId, {
          turnId: input.turnId,
          holderId: input.holderId,
          generation: input.generation,
        });
        if (!condition) {
          return {
            action: "stale",
            failoverCount: metadata.failoverCount,
            maxFailovers,
          } as const;
        }
        const [credential] = await tx
          .select({
            version: schema.codexSubscriptionCredentials.version,
            exhaustedRevision:
              input.quarantine.kind === "cooldown"
                ? schema.codexSubscriptionCredentials.exhaustedRevision
                : sql<number>`0`,
            planEntitlementExclusion: schema.codexSubscriptionCredentials.planEntitlementExclusion,
          })
          .from(schema.codexSubscriptionCredentials)
          .where(
            and(
              eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
              eq(schema.codexSubscriptionCredentials.id, input.credentialId),
              condition,
            ),
          )
          .for("update")
          .limit(1);
        if (!credential) {
          return {
            action: "stale",
            failoverCount: metadata.failoverCount,
            maxFailovers,
          } as const;
        }
        if (credential.version !== input.credentialVersion) {
          return {
            action: "credential_changed",
            failoverCount: metadata.failoverCount,
            maxFailovers,
            currentCredentialVersion: credential.version,
          } as const;
        }
        if (
          input.quarantine.kind === "included_usage" ||
          input.quarantine.kind === "usage_verification"
        ) {
          await tx
            .update(schema.codexSubscriptionCredentials)
            .set(
              input.quarantine.kind === "usage_verification"
                ? {
                    exhaustedUntil: sql`greatest(${schema.codexSubscriptionCredentials.exhaustedUntil}, ${input.quarantine.until.toISOString()}::timestamptz)`,
                    exhaustedKind: sql`case when ${schema.codexSubscriptionCredentials.exhaustedUntil} >= ${input.quarantine.until.toISOString()}::timestamptz then ${schema.codexSubscriptionCredentials.exhaustedKind} else 'rate_limit' end`,
                    exhaustedRevision: sql`${schema.codexSubscriptionCredentials.exhaustedRevision} + 1`,
                  }
                : {
                    includedUsageUnavailableUntil: new Date(
                      Math.min(input.quarantine.until.getTime(), Date.now() + 60_000),
                    ),
                  },
            )
            .where(and(eq(schema.codexSubscriptionCredentials.id, input.credentialId), condition));
          return {
            action: "recorded",
            failoverCount: metadata.failoverCount,
            maxFailovers,
            exhausted: false,
          } as const;
        }
        const planKey =
          input.quarantine.kind === "plan_entitlement"
            ? codexPlanKey(input.quarantine.planType)
            : null;
        const updated = await tx
          .update(schema.codexSubscriptionCredentials)
          .set(
            input.quarantine.kind === "status"
              ? {
                  status: input.quarantine.status,
                  lastError: input.quarantine.lastError,
                  updatedAt: new Date(),
                }
              : input.quarantine.kind === "plan_entitlement"
                ? {
                    planEntitlementExclusion: serializeCodexPlanEntitlementExclusion(
                      mergeCodexPlanEntitlementExclusion(
                        readCodexPlanEntitlementExclusion(credential.planEntitlementExclusion),
                        input.quarantine.planType,
                        input.quarantine.modelId,
                        new Date(),
                      ),
                    ),
                    updatedAt: new Date(),
                  }
                : {
                    exhaustedUntil: input.quarantine.until,
                    exhaustedKind: input.quarantine.cooldownKind,
                    exhaustedRevision: sql`${schema.codexSubscriptionCredentials.exhaustedRevision} + 1`,
                  },
          )
          .where(
            and(
              eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
              eq(schema.codexSubscriptionCredentials.id, input.credentialId),
              eq(schema.codexSubscriptionCredentials.version, input.credentialVersion),
              condition,
            ),
          )
          .returning({ id: schema.codexSubscriptionCredentials.id });
        if (updated.length === 0) {
          return {
            action: "stale",
            failoverCount: metadata.failoverCount,
            maxFailovers,
          } as const;
        }
        const alreadyRecorded = metadata.failedCredentialIds.has(input.credentialId);
        const failedCredentialIds = alreadyRecorded
          ? [...metadata.failedCredentialIds]
          : [...metadata.failedCredentialIds, input.credentialId];
        const failoverCount = alreadyRecorded
          ? metadata.failoverCount
          : Math.max(metadata.failoverCount + 1, failedCredentialIds.length);
        const exhausted = failoverCount > maxFailovers;
        const [accountedTurn] = await tx
          .update(schema.sessionTurns)
          .set({
            metadata: {
              ...turn.metadata,
              codexCredentialFailureAccountingVersion: 1,
              codexCredentialFailedIds: failedCredentialIds,
              codexCredentialFailureCooldownRevisions: {
                ...(turn.metadata?.codexCredentialFailureCooldownRevisions as
                  | Record<string, unknown>
                  | undefined),
                [input.credentialId]:
                  input.quarantine.kind === "cooldown" ? credential.exhaustedRevision + 1 : null,
              },
              codexCredentialFailureEvidenceV1: {
                ...(turn.metadata?.codexCredentialFailureEvidenceV1 as
                  | Record<string, unknown>
                  | undefined),
                [input.credentialId]:
                  input.quarantine.kind === "status"
                    ? { kind: "status", credentialVersion: credential.version }
                    : input.quarantine.kind === "plan_entitlement"
                      ? {
                          kind: "plan",
                          credentialVersion: credential.version,
                          planType: input.quarantine.planObserved === false ? null : planKey,
                        }
                      : {
                          kind: input.quarantine.cooldownKind,
                          cooldownRevision: credential.exhaustedRevision + 1,
                        },
              },
              codexCredentialFailovers: failoverCount,
              codexCredentialFailoverLimit: maxFailovers,
              codexCredentialFailoverExhausted: exhausted,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.activeAttemptId, input.attemptId),
              eq(schema.sessionTurns.executionGeneration, input.executionGeneration),
            ),
          )
          .returning({ id: schema.sessionTurns.id });
        if (!accountedTurn) {
          throw new Error("Codex quarantine lost its exact turn accounting fence");
        }
        return { action: "recorded", failoverCount, maxFailovers, exhausted } as const;
      }),
  );
}

export async function listCodexAccountStatuses(
  db: Database,
  workspaceId: string,
  acceptedTurnId?: string,
): Promise<CodexAccountStatus[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const pool = await effectiveCodexCredentialPoolCondition(scopedDb, workspaceId);
    if (acceptedTurnId) {
      const source = await codexSourceForTurn(
        scopedDb,
        workspaceId,
        acceptedTurnId,
        pool.source.effectiveSource,
      );
      pool.source.effectiveSource = source;
      pool.condition =
        source === "disabled"
          ? null
          : codexCredentialPoolCondition({
              accountId: pool.source.accountId,
              workspaceId,
              source,
            });
    }
    if (!pool.condition || pool.source.effectiveSource === "disabled") return [];
    const accountSource: "workspace" | "organization" = pool.source.effectiveSource;
    const [settingsRow] =
      pool.source.effectiveSource === "organization"
        ? await scopedDb
            .select({
              activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
            })
            .from(schema.organizationCodexRotationSettings)
            .where(eq(schema.organizationCodexRotationSettings.accountId, pool.source.accountId))
            .limit(1)
        : await scopedDb
            .select({
              activeCredentialId: schema.codexRotationSettings.activeCredentialId,
            })
            .from(schema.codexRotationSettings)
            .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
            .limit(1);
    let activeId = settingsRow?.activeCredentialId ?? null;
    const rows = await scopedDb
      .select({
        id: schema.codexSubscriptionCredentials.id,
        chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
        allowedModelIds: schema.codexSubscriptionCredentials.allowedModelIds,
        label: schema.codexSubscriptionCredentials.label,
        accountEmail: schema.codexSubscriptionCredentials.accountEmail,
        planType: schema.codexSubscriptionCredentials.planType,
        planCheckedAt: schema.codexSubscriptionCredentials.planCheckedAt,
        planPreviousType: schema.codexSubscriptionCredentials.planPreviousType,
        planChangedAt: schema.codexSubscriptionCredentials.planChangedAt,
        planEntitlementExclusion: schema.codexSubscriptionCredentials.planEntitlementExclusion,
        status: schema.codexSubscriptionCredentials.status,
        extraCreditsEnabled: schema.codexSubscriptionCredentials.extraCreditsEnabled,
        extraCreditsVersion: schema.codexSubscriptionCredentials.extraCreditsVersion,
        extraCreditsUpdatedAt: schema.codexSubscriptionCredentials.extraCreditsUpdatedAt,
        includedUsageUnavailableUntil:
          schema.codexSubscriptionCredentials.includedUsageUnavailableUntil,
        allocatorEnabled: schema.codexSubscriptionCredentials.allocatorEnabled,
        allocatorVersion: schema.codexSubscriptionCredentials.allocatorVersion,
        allocatorUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.allocatorUpdatedBySubjectId,
        allocatorUpdatedAt: schema.codexSubscriptionCredentials.allocatorUpdatedAt,
        resetCreditAvailableCount: schema.codexSubscriptionCredentials.resetCreditAvailableCount,
        resetCreditsCheckedAt: schema.codexSubscriptionCredentials.resetCreditsCheckedAt,
        connectedBySubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
        expiresAt: schema.codexSubscriptionCredentials.expiresAt,
        lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
        lastError: schema.codexSubscriptionCredentials.lastError,
        // P2/P3 cached capacity metadata is strictly workspace-local.
        primaryUsedPercent: schema.codexSubscriptionCredentials.primaryUsedPercent,
        primaryResetAt: schema.codexSubscriptionCredentials.primaryResetAt,
        secondaryUsedPercent: schema.codexSubscriptionCredentials.secondaryUsedPercent,
        secondaryResetAt: schema.codexSubscriptionCredentials.secondaryResetAt,
        usageCheckedAt: schema.codexSubscriptionCredentials.usageCheckedAt,
        exhaustedUntil: schema.codexSubscriptionCredentials.exhaustedUntil,
        exhaustedKind: schema.codexSubscriptionCredentials.exhaustedKind,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(pool.condition)
      .orderBy(
        asc(schema.codexSubscriptionCredentials.createdAt),
        asc(schema.codexSubscriptionCredentials.id),
      );
    if (accountSource === "organization") activeId = assignedConnectionDefault(activeId, rows);
    return rows.map((row) => ({
      ...row,
      source: accountSource,
      planCheckedAt: codexMetadataDate(row.planCheckedAt),
      planChangedAt: codexMetadataDate(row.planChangedAt),
      planEntitlementExclusion: readCodexPlanEntitlementExclusion(row.planEntitlementExclusion),
      expiresAt: codexMetadataDate(row.expiresAt),
      lastRefreshAt: codexMetadataDate(row.lastRefreshAt),
      extraCreditsUpdatedAt: codexMetadataDate(row.extraCreditsUpdatedAt),
      includedUsageUnavailableUntil: codexMetadataDate(row.includedUsageUnavailableUntil),
      allocatorUpdatedAt: codexMetadataDate(row.allocatorUpdatedAt),
      resetCreditsCheckedAt: codexMetadataDate(row.resetCreditsCheckedAt),
      primaryResetAt: codexMetadataDate(row.primaryResetAt),
      secondaryResetAt: codexMetadataDate(row.secondaryResetAt),
      usageCheckedAt: codexMetadataDate(row.usageCheckedAt),
      exhaustedUntil: codexMetadataDate(row.exhaustedUntil),
      exhaustedKind:
        row.exhaustedKind === "quota" || row.exhaustedKind === "rate_limit"
          ? row.exhaustedKind
          : null,
      isActive: row.id === activeId,
    }));
  });
}

export async function getSessionCodexAccounts(
  db: Database,
  workspaceId: string,
  sessionId: string,
) {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`codex-subscription-source:${workspaceId}`}, 0))`,
    );
    const [session] = await tx
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("share")
      .limit(1);
    if (!session) return null;
    const [turn] = session.activeTurnId
      ? await tx
          .select({
            id: schema.sessionTurns.id,
            metadata: schema.sessionTurns.metadata,
            status: schema.sessionTurns.status,
            credentialId: schema.codexCredentialLeases.credentialId,
          })
          .from(schema.sessionTurns)
          .leftJoin(
            schema.codexCredentialLeases,
            and(
              eq(schema.codexCredentialLeases.workspaceId, schema.sessionTurns.workspaceId),
              eq(schema.codexCredentialLeases.turnId, schema.sessionTurns.id),
              sql`${schema.codexCredentialLeases.leasedUntil} > clock_timestamp()`,
            ),
          )
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, workspaceId),
              eq(schema.sessionTurns.accountId, session.accountId),
              eq(schema.sessionTurns.sessionId, session.id),
              eq(schema.sessionTurns.id, session.activeTurnId),
              inArray(schema.sessionTurns.status, [
                "running",
                "recovering",
                "waiting_capacity",
                "requires_action",
              ]),
              sql`${schema.sessionTurns.model} like 'codex/%'`,
            ),
          )
          .limit(1)
      : [];
    const accepted = readCodexCredentialPolicySnapshotV1(turn?.metadata);
    const policy = accepted.kind === "valid" ? accepted.policy : null;
    const waiting = turn?.status === "waiting_capacity";
    const currentSelection = turn
      ? {
          waiting,
          credentialId: waiting
            ? !policy && session.codexPinSource !== "policy"
              ? session.codexPinnedCredentialId
              : policy?.pinSource === "manual"
                ? policy.pinnedCredentialId
                : policy?.rotationEnabled === false
                  ? policy.activeCredentialId
                  : null
            : turn.credentialId,
        }
      : null;
    const acceptedTurnId = waiting ? turn.id : undefined;
    const accounts = await listCodexAccountStatuses(tx, workspaceId, acceptedTurnId);
    const rotation = await getCodexRotationSettings(tx, workspaceId, acceptedTurnId);
    const currentAccounts =
      turn && !waiting && currentSelection?.credentialId
        ? await listCodexAccountStatuses(tx, workspaceId, turn.id)
        : accounts;
    return {
      accounts,
      rotation,
      currentSelection,
      currentAccount:
        currentAccounts.find((account) => account.id === currentSelection?.credentialId) ?? null,
      pinnedAccountId:
        waiting && policy ? policy.pinnedCredentialId : session.codexPinnedCredentialId,
      lastAccountId: session.codexLastCredentialId,
    };
  });
}

export async function updateCodexAllocatorEligibility(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string | null;
    credentialId: string;
    subjectId: string;
    enabled: boolean;
    expectedVersion: number;
  },
): Promise<CodexCapacityMutationResult<CodexAllocatorUpdateResult>> {
  const scope =
    input.workspaceId === null
      ? and(
          eq(schema.codexSubscriptionCredentials.organizationId, input.accountId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        )
      : eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId);
  const mutate = async (
    tx: Database,
  ): Promise<{ result: CodexAllocatorUpdateResult; changed: boolean }> => {
    const [row] = await tx
      .select({
        allocatorEnabled: schema.codexSubscriptionCredentials.allocatorEnabled,
        allocatorVersion: schema.codexSubscriptionCredentials.allocatorVersion,
        allocatorUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.allocatorUpdatedBySubjectId,
        allocatorUpdatedAt: schema.codexSubscriptionCredentials.allocatorUpdatedAt,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
          scope,
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return { result: { kind: "not_found" } as const, changed: false };
    const current = {
      allocatorEnabled: row.allocatorEnabled,
      allocatorVersion: row.allocatorVersion,
      allocatorUpdatedBySubjectId: row.allocatorUpdatedBySubjectId,
      allocatorUpdatedAt: codexMetadataDate(row.allocatorUpdatedAt),
    };
    if (row.allocatorEnabled === input.enabled) {
      return {
        result: { kind: "unchanged", ...current } as const,
        changed: false,
      };
    }
    if (row.allocatorVersion !== input.expectedVersion) {
      return {
        result: { kind: "conflict", ...current } as const,
        changed: false,
      };
    }

    const changedAt = new Date();
    const [updated] = await tx
      .update(schema.codexSubscriptionCredentials)
      .set({
        allocatorEnabled: input.enabled,
        allocatorVersion: sql`${schema.codexSubscriptionCredentials.allocatorVersion} + 1`,
        allocatorUpdatedBySubjectId: input.subjectId,
        allocatorUpdatedAt: changedAt,
        // Deliberately no credential version/updatedAt write.
      })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
          scope,
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          eq(schema.codexSubscriptionCredentials.allocatorVersion, input.expectedVersion),
        ),
      )
      .returning({
        allocatorEnabled: schema.codexSubscriptionCredentials.allocatorEnabled,
        allocatorVersion: schema.codexSubscriptionCredentials.allocatorVersion,
        allocatorUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.allocatorUpdatedBySubjectId,
        allocatorUpdatedAt: schema.codexSubscriptionCredentials.allocatorUpdatedAt,
      });
    if (!updated) {
      throw new Error("Codex allocator row changed while locked");
    }
    await tx.insert(schema.auditEvents).values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          action: "codex.allocator.updated",
          targetType: "codex_subscription_credential",
          targetId: input.credentialId,
          metadata: {
            allocatorEnabled: updated.allocatorEnabled,
            allocatorVersion: updated.allocatorVersion,
          },
        },
        "metadata",
        "metadataCodecVersion",
      ),
    );
    return {
      result: {
        kind: "updated",
        allocatorEnabled: updated.allocatorEnabled,
        allocatorVersion: updated.allocatorVersion,
        allocatorUpdatedBySubjectId: updated.allocatorUpdatedBySubjectId,
        allocatorUpdatedAt: codexMetadataDate(updated.allocatorUpdatedAt),
      } as const,
      changed: true,
    };
  };
  if (input.workspaceId === null) {
    return await withOrganizationCodexAdministrator(
      db,
      { organizationId: input.accountId, actorSubjectId: input.subjectId },
      async (tx) => {
        await lockOrganizationCodexSubscriptionSources(tx, input.accountId);
        await tx
          .select({ accountId: schema.organizationCodexRotationSettings.accountId })
          .from(schema.organizationCodexRotationSettings)
          .where(eq(schema.organizationCodexRotationSettings.accountId, input.accountId))
          .for("update");
        const mutation = await mutate(tx);
        const wakeTargets = mutation.changed
          ? await wakeOrganizationCodexCapacityWaitersInTransaction(tx, {
              accountId: input.accountId,
              reason: "codex_allocator_eligibility_changed",
              restoreWorkspaceId: null,
            })
          : [];
        return { result: mutation.result, wakeTargets };
      },
    );
  }
  return await withCodexCapacityMutation(
    db,
    {
      workspaceId: input.workspaceId,
      reason: "codex_allocator_eligibility_changed",
    },
    mutate,
  );
}

export async function updateCodexExtraCreditsPolicy(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string | null;
    credentialId: string;
    subjectId: string;
    enabled: boolean;
    expectedVersion: number;
  },
): Promise<CodexCapacityMutationResult<CodexExtraCreditsUpdateResult>> {
  const scope =
    input.workspaceId === null
      ? and(
          eq(schema.codexSubscriptionCredentials.organizationId, input.accountId),
          eq(schema.codexSubscriptionCredentials.authorityScope, "organization"),
        )
      : eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId);
  const mutate = async (
    tx: Database,
  ): Promise<{ result: CodexExtraCreditsUpdateResult; changed: boolean }> => {
    const [row] = await tx
      .select({
        extraCreditsEnabled: schema.codexSubscriptionCredentials.extraCreditsEnabled,
        extraCreditsVersion: schema.codexSubscriptionCredentials.extraCreditsVersion,
        extraCreditsUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.extraCreditsUpdatedBySubjectId,
        extraCreditsUpdatedAt: schema.codexSubscriptionCredentials.extraCreditsUpdatedAt,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
          scope,
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return { result: { kind: "not_found" } as const, changed: false };
    const current = {
      extraCreditsEnabled: row.extraCreditsEnabled,
      extraCreditsVersion: row.extraCreditsVersion,
      extraCreditsUpdatedBySubjectId: row.extraCreditsUpdatedBySubjectId,
      extraCreditsUpdatedAt: codexMetadataDate(row.extraCreditsUpdatedAt),
    };
    if (row.extraCreditsEnabled === input.enabled) {
      return {
        result: { kind: "unchanged", ...current } as const,
        changed: false,
      };
    }
    if (row.extraCreditsVersion !== input.expectedVersion) {
      return {
        result: { kind: "conflict", ...current } as const,
        changed: false,
      };
    }

    const changedAt = new Date();
    const [updated] = await tx
      .update(schema.codexSubscriptionCredentials)
      .set({
        extraCreditsEnabled: input.enabled,
        extraCreditsVersion: sql`${schema.codexSubscriptionCredentials.extraCreditsVersion} + 1`,
        extraCreditsUpdatedBySubjectId: input.subjectId,
        extraCreditsUpdatedAt: changedAt,
        // Deliberately no credential version/updatedAt write.
      })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
          scope,
          eq(schema.codexSubscriptionCredentials.id, input.credentialId),
          eq(schema.codexSubscriptionCredentials.extraCreditsVersion, input.expectedVersion),
        ),
      )
      .returning({
        extraCreditsEnabled: schema.codexSubscriptionCredentials.extraCreditsEnabled,
        extraCreditsVersion: schema.codexSubscriptionCredentials.extraCreditsVersion,
        extraCreditsUpdatedBySubjectId:
          schema.codexSubscriptionCredentials.extraCreditsUpdatedBySubjectId,
        extraCreditsUpdatedAt: schema.codexSubscriptionCredentials.extraCreditsUpdatedAt,
      });
    if (!updated) {
      throw new Error("Codex credit-policy row changed while locked");
    }
    await tx.insert(schema.auditEvents).values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          action: "codex.extra_credits.updated",
          targetType: "codex_subscription_credential",
          targetId: input.credentialId,
          metadata: {
            extraCreditsEnabled: updated.extraCreditsEnabled,
            extraCreditsVersion: updated.extraCreditsVersion,
          },
        },
        "metadata",
        "metadataCodecVersion",
      ),
    );
    return {
      result: {
        kind: "updated",
        extraCreditsEnabled: updated.extraCreditsEnabled,
        extraCreditsVersion: updated.extraCreditsVersion,
        extraCreditsUpdatedBySubjectId: updated.extraCreditsUpdatedBySubjectId,
        extraCreditsUpdatedAt: codexMetadataDate(updated.extraCreditsUpdatedAt),
      } as const,
      changed: true,
    };
  };
  if (input.workspaceId === null) {
    return await withOrganizationCodexAdministrator(
      db,
      { organizationId: input.accountId, actorSubjectId: input.subjectId },
      async (tx) => {
        await lockOrganizationCodexSubscriptionSources(tx, input.accountId);
        await tx
          .select({ accountId: schema.organizationCodexRotationSettings.accountId })
          .from(schema.organizationCodexRotationSettings)
          .where(eq(schema.organizationCodexRotationSettings.accountId, input.accountId))
          .for("update");
        const mutation = await mutate(tx);
        const wakeTargets = mutation.changed
          ? await wakeOrganizationCodexCapacityWaitersInTransaction(tx, {
              accountId: input.accountId,
              reason: "codex_extra_credits_policy_changed",
              restoreWorkspaceId: null,
            })
          : [];
        return { result: mutation.result, wakeTargets };
      },
    );
  }
  return await withCodexCapacityMutation(
    db,
    {
      workspaceId: input.workspaceId,
      reason: "codex_extra_credits_policy_changed",
    },
    mutate,
  );
}

function mapCodexResetRedemptionAttempt(
  row: typeof schema.codexResetRedemptionAttempts.$inferSelect,
): CodexResetRedemptionAttempt {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    credentialId: row.credentialId,
    subjectId: row.subjectId,
    browserSessionHash: row.browserSessionHash,
    creditId: row.creditId,
    upstreamIdempotencyKey: row.upstreamIdempotencyKey,
    status: row.status as CodexResetRedemptionStatus,
    outcome: row.outcome as CodexResetRedemptionOutcome | null,
    claimHolderId: row.claimHolderId,
    claimExpiresAt: codexMetadataDate(row.claimExpiresAt),
    confirmationExpiresAt: codexMetadataDate(row.confirmationExpiresAt)!,
    providerStartedAt: codexMetadataDate(row.providerStartedAt),
    completedAt: codexMetadataDate(row.completedAt),
    lastFailureKind: row.lastFailureKind,
    retryCount: row.retryCount,
    createdAt: codexMetadataDate(row.createdAt)!,
    updatedAt: codexMetadataDate(row.updatedAt)!,
  };
}

export async function listCodexResetRedemptionRecoveries(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<CodexResetRedemptionRecovery[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({
          attemptId: schema.codexResetRedemptionAttempts.id,
          credentialId: schema.codexResetRedemptionAttempts.credentialId,
          creditId: schema.codexResetRedemptionAttempts.creditId,
          status: schema.codexResetRedemptionAttempts.status,
          outcome: schema.codexResetRedemptionAttempts.outcome,
          providerStartedAt: schema.codexResetRedemptionAttempts.providerStartedAt,
          completedAt: schema.codexResetRedemptionAttempts.completedAt,
          createdAt: schema.codexResetRedemptionAttempts.createdAt,
          updatedAt: schema.codexResetRedemptionAttempts.updatedAt,
        })
        .from(schema.codexResetRedemptionAttempts)
        .innerJoin(
          schema.codexSubscriptionCredentials,
          and(
            eq(
              schema.codexSubscriptionCredentials.id,
              schema.codexResetRedemptionAttempts.credentialId,
            ),
            eq(
              schema.codexSubscriptionCredentials.workspaceId,
              schema.codexResetRedemptionAttempts.workspaceId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
            eq(schema.codexResetRedemptionAttempts.subjectId, input.subjectId),
            eq(schema.codexSubscriptionCredentials.connectedBySubjectId, input.subjectId),
            inArray(schema.codexResetRedemptionAttempts.status, ["provider_started", "completed"]),
          ),
        )
        .orderBy(desc(schema.codexResetRedemptionAttempts.createdAt));
      return rows.map((row) => ({
        attemptId: row.attemptId,
        credentialId: row.credentialId,
        creditId: row.creditId,
        status: row.status as "provider_started" | "completed",
        outcome: row.outcome as CodexResetRedemptionOutcome | null,
        providerStartedAt: codexMetadataDate(row.providerStartedAt),
        completedAt: codexMetadataDate(row.completedAt),
        createdAt: codexMetadataDate(row.createdAt)!,
        updatedAt: codexMetadataDate(row.updatedAt)!,
      }));
    },
  );
}

export async function legacyCodexResetRedemptionAuthority(
  tx: Database,
  input: { accountId: string; workspaceId: string; credentialId: string; subjectId: string },
): Promise<{ status: string; owned: boolean } | null> {
  const [credential] = await tx
    .select({
      connectedBySubjectId: schema.codexSubscriptionCredentials.connectedBySubjectId,
      status: schema.codexSubscriptionCredentials.status,
    })
    .from(schema.codexSubscriptionCredentials)
    .where(
      and(
        eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
        eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
        eq(schema.codexSubscriptionCredentials.id, input.credentialId),
      ),
    )
    .for("share")
    .limit(1);
  return credential
    ? { status: credential.status, owned: credential.connectedBySubjectId === input.subjectId }
    : null;
}

export async function adoptCodexResetRedemptionAttempt(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    attemptId: string;
    credentialId: string;
    creditId: string;
    subjectId: string;
    browserSessionHash: string;
  },
  authority: CodexResetRedemptionCredentialAuthority = legacyCodexResetRedemptionAuthority,
): Promise<AdoptCodexResetRedemptionResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const credential = await authority(tx as unknown as Database, input);
        if (!credential) return { kind: "not_found" } as const;
        if (!credential.owned) {
          return { kind: "forbidden" } as const;
        }
        const [attempt] = await tx
          .select()
          .from(schema.codexResetRedemptionAttempts)
          .where(
            and(
              eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
              eq(schema.codexResetRedemptionAttempts.id, input.attemptId),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) return { kind: "not_found" } as const;
        if (
          attempt.accountId !== input.accountId ||
          attempt.credentialId !== input.credentialId ||
          attempt.creditId !== input.creditId ||
          attempt.subjectId !== input.subjectId
        ) {
          return { kind: "conflict" } as const;
        }
        if (attempt.browserSessionHash === input.browserSessionHash) {
          return {
            kind: "current",
            attempt: mapCodexResetRedemptionAttempt(attempt),
          } as const;
        }
        if (attempt.status !== "provider_started" && attempt.status !== "completed") {
          return { kind: "conflict" } as const;
        }
        const claim = await tx.execute<{ claim_live: boolean }>(sql`
          select claim_expires_at > now() as claim_live
          from codex_reset_redemption_attempts
          where workspace_id = ${input.workspaceId} and id = ${input.attemptId}
        `);
        if (claim[0]?.claim_live) return { kind: "in_progress" } as const;
        const [adopted] = await tx
          .update(schema.codexResetRedemptionAttempts)
          .set({
            browserSessionHash: input.browserSessionHash,
            claimHolderId: null,
            claimExpiresAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.codexResetRedemptionAttempts.id, input.attemptId))
          .returning();
        if (!adopted) throw new Error("Codex redemption adoption returned no row");
        return {
          kind: "adopted",
          attempt: mapCodexResetRedemptionAttempt(adopted),
        } as const;
      }),
  );
}

export async function claimCodexResetRedemption(
  db: Database,
  input: {
    id: string;
    accountId: string;
    workspaceId: string;
    credentialId: string;
    subjectId: string;
    browserSessionHash: string;
    creditId: string;
    confirmationExpiresAt: Date;
    claimHolderId: string;
    claimTtlMs?: number;
  },
  authority: CodexResetRedemptionCredentialAuthority = legacyCodexResetRedemptionAuthority,
  creditFence: CodexResetCreditFence | null = null,
): Promise<ClaimCodexResetRedemptionResult> {
  const claimTtlMs = input.claimTtlMs ?? 60_000;
  if (!Number.isFinite(claimTtlMs) || claimTtlMs <= 0) {
    throw new Error("Codex redemption claim TTL must be positive");
  }
  if (
    !Number.isFinite(input.confirmationExpiresAt.getTime()) ||
    input.confirmationExpiresAt.getTime() <= Date.now()
  ) {
    return { kind: "forbidden" };
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`codex-reset-attempt:${input.id}`}, 0))`,
        );
        // A second browser tab has a different attempt UUID. Serialize on the
        // irreversible provider credit too, then let the unique index provide
        // the durable fail-closed backstop.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`codex-reset-credit:${input.workspaceId}:${input.credentialId}:${input.creditId}`}, 0))`,
        );
        const credential = await authority(tx as unknown as Database, input);
        if (!credential) return { kind: "not_found" } as const;
        // The core ledger also fences the credit across workspaces: another
        // workspace's open or consumed attempt for the same credit wins, and
        // the caller's own attempt filed elsewhere is moved here to recover.
        if (creditFence) {
          const fence = await creditFence(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            credentialId: input.credentialId,
            subjectId: input.subjectId,
            creditId: input.creditId,
            attemptId: input.id,
          });
          if (fence === "refused") return { kind: "forbidden" } as const;
          if (fence === "held_elsewhere") return { kind: "conflict" } as const;
        }
        const [existing] = await tx
          .select()
          .from(schema.codexResetRedemptionAttempts)
          .where(
            and(
              eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
              eq(schema.codexResetRedemptionAttempts.id, input.id),
            ),
          )
          .for("update")
          .limit(1);
        const now = new Date();
        if (existing) {
          if (
            existing.accountId !== input.accountId ||
            existing.credentialId !== input.credentialId ||
            existing.subjectId !== input.subjectId ||
            existing.browserSessionHash !== input.browserSessionHash ||
            existing.creditId !== input.creditId
          ) {
            return { kind: "conflict" } as const;
          }
          if (!credential.owned) {
            return { kind: "forbidden" } as const;
          }
          const mapped = mapCodexResetRedemptionAttempt(existing);
          // Completion is durable truth. A token-health transition after the
          // provider outcome committed must not turn an HTTP-response-loss
          // replay into a false 403 or trigger a second consume. Current human
          // ownership remains mandatory, but active health is needed only when
          // work may still have to reach the provider.
          if (mapped.status === "completed") return { kind: "completed", attempt: mapped };
          if (credential.status !== "active") {
            return { kind: "forbidden" } as const;
          }
          const claimState = await tx.execute(sql<{ claim_live: boolean }>`
            select claim_expires_at > now() as claim_live
            from codex_reset_redemption_attempts
            where workspace_id = ${input.workspaceId} and id = ${input.id}
          `);
          if (claimState[0]?.claim_live) {
            return { kind: "in_progress", attempt: mapped };
          }
          const [reclaimed] = await tx
            .update(schema.codexResetRedemptionAttempts)
            .set({
              claimHolderId: input.claimHolderId,
              claimExpiresAt: sql`now() + (${claimTtlMs} * interval '1 millisecond')`,
              confirmationExpiresAt: input.confirmationExpiresAt,
              lastFailureKind: null,
              retryCount: sql`${schema.codexResetRedemptionAttempts.retryCount} + 1`,
              updatedAt: now,
            })
            .where(eq(schema.codexResetRedemptionAttempts.id, input.id))
            .returning();
          if (!reclaimed) throw new Error("Codex redemption reclaim returned no row");
          return {
            kind: "claimed",
            attempt: mapCodexResetRedemptionAttempt(reclaimed),
          };
        }

        // Authorize before looking up credit-attempt state so a non-owner cannot
        // distinguish an unused provider credit from one with an existing attempt.
        if (credential.status !== "active" || !credential.owned) {
          return { kind: "forbidden" } as const;
        }

        const [creditAttempt] = await tx.execute<{
          id: string;
          status: CodexResetRedemptionStatus;
          claim_live: boolean | null;
        }>(sql`
          select id, status, claim_expires_at > now() as claim_live
          from codex_reset_redemption_attempts
          where workspace_id = ${input.workspaceId}
            and credential_id = ${input.credentialId}
            and credit_id = ${input.creditId}
            and (status <> 'completed' or outcome in ('reset', 'alreadyRedeemed'))
          limit 1
          for update
        `);
        if (creditAttempt) {
          // A different browser UUID may replace only definite pre-provider
          // work whose claim is released/expired. The per-credit advisory lock
          // serializes replacement with a late original claimant, and the
          // DB-time predicate prevents an application-clock race. Once
          // provider_started (or successfully completed), preserve the one
          // upstream idempotency key and fail closed.
          if (creditAttempt.status !== "processing" || creditAttempt.claim_live) {
            return { kind: "conflict" } as const;
          }
          const removed = await tx
            .delete(schema.codexResetRedemptionAttempts)
            .where(
              and(
                eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
                eq(schema.codexResetRedemptionAttempts.id, creditAttempt.id),
                eq(schema.codexResetRedemptionAttempts.status, "processing"),
                sql`(${schema.codexResetRedemptionAttempts.claimExpiresAt} is null or ${schema.codexResetRedemptionAttempts.claimExpiresAt} <= now())`,
              ),
            )
            .returning({ id: schema.codexResetRedemptionAttempts.id });
          if (removed.length !== 1) return { kind: "conflict" } as const;
        }

        const [created] = await tx
          .insert(schema.codexResetRedemptionAttempts)
          .values({
            id: input.id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            credentialId: input.credentialId,
            subjectId: input.subjectId,
            browserSessionHash: input.browserSessionHash,
            creditId: input.creditId,
            status: "processing",
            claimHolderId: input.claimHolderId,
            claimExpiresAt: sql`now() + (${claimTtlMs} * interval '1 millisecond')`,
            confirmationExpiresAt: input.confirmationExpiresAt,
          })
          .returning();
        if (!created) throw new Error("Codex redemption claim returned no row");
        return {
          kind: "claimed",
          attempt: mapCodexResetRedemptionAttempt(created),
        };
      }),
  );
}

export async function fenceCodexResetRedemptionSend(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    attemptId: string;
    claimHolderId: string;
    credentialId: string;
    subjectId: string;
    browserSessionHash: string;
    sendLeaseMs?: number;
  },
  authority: CodexResetRedemptionCredentialAuthority = legacyCodexResetRedemptionAuthority,
): Promise<FenceCodexResetRedemptionSendResult> {
  const sendLeaseMs = input.sendLeaseMs ?? 30_000;
  if (!Number.isFinite(sendLeaseMs) || sendLeaseMs <= 10_000) {
    throw new Error("Codex redemption send lease must exceed the bounded provider call");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const credential = await authority(tx as unknown as Database, input);
        const [attempt] = await tx
          .select()
          .from(schema.codexResetRedemptionAttempts)
          .where(
            and(
              eq(schema.codexResetRedemptionAttempts.accountId, input.accountId),
              eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
              eq(schema.codexResetRedemptionAttempts.id, input.attemptId),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) return { kind: "not_ready", reason: "not_found" } as const;
        if (
          attempt.credentialId !== input.credentialId ||
          attempt.subjectId !== input.subjectId ||
          attempt.browserSessionHash !== input.browserSessionHash ||
          attempt.claimHolderId !== input.claimHolderId
        ) {
          return { kind: "not_ready", reason: "identity_mismatch" } as const;
        }
        if (attempt.status === "completed") {
          return { kind: "not_ready", reason: "already_completed" } as const;
        }
        const [liveness] = await tx.execute<{
          claim_live: boolean;
          confirmation_live: boolean;
        }>(sql`
          select claim_expires_at > now() as claim_live,
                 confirmation_expires_at > now() as confirmation_live
          from codex_reset_redemption_attempts
          where workspace_id = ${input.workspaceId} and id = ${input.attemptId}
        `);
        let reason: CodexResetRedemptionSendNotReadyReason;
        if (!liveness?.claim_live) reason = "claim_expired";
        else if (!liveness.confirmation_live) reason = "confirmation_expired";
        else if (!credential || credential.status !== "active" || !credential.owned) {
          reason = "credential_unavailable";
        } else {
          const [ready] = await tx
            .update(schema.codexResetRedemptionAttempts)
            .set({
              status: "provider_started",
              providerStartedAt: sql`coalesce(${schema.codexResetRedemptionAttempts.providerStartedAt}, now())`,
              claimExpiresAt: sql`now() + (${sendLeaseMs} * interval '1 millisecond')`,
              lastFailureKind: null,
              updatedAt: sql`now()`,
            })
            .where(eq(schema.codexResetRedemptionAttempts.id, input.attemptId))
            .returning();
          if (!ready) throw new Error("Codex redemption send fence returned no row");
          return {
            kind: "ready",
            attempt: mapCodexResetRedemptionAttempt(ready),
          } as const;
        }

        // Before provider_started it is safe to remove the false logical
        // attempt. Once provider work may have begun, preserve the upstream key
        // and merely release this request's stale claim for owner recovery.
        if (attempt.status === "processing") {
          await tx
            .delete(schema.codexResetRedemptionAttempts)
            .where(eq(schema.codexResetRedemptionAttempts.id, input.attemptId));
        } else {
          await tx
            .update(schema.codexResetRedemptionAttempts)
            .set({
              claimHolderId: null,
              claimExpiresAt: null,
              lastFailureKind: `send_fence_${reason}`,
              updatedAt: sql`now()`,
            })
            .where(eq(schema.codexResetRedemptionAttempts.id, input.attemptId));
        }
        return { kind: "not_ready", reason } as const;
      }),
  );
}

export async function completeCodexResetRedemption(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    attemptId: string;
    claimHolderId: string;
    outcome: CodexResetRedemptionOutcome;
  },
): Promise<CodexCapacityMutationResult<CodexResetRedemptionAttempt | null>> {
  if (!CODEX_RESET_REDEMPTION_OUTCOMES.includes(input.outcome)) {
    throw new Error("Unknown Codex redemption outcome");
  }
  return await withCodexCapacityMutation(
    db,
    { workspaceId: input.workspaceId, reason: "codex_reset_credit_redeemed" },
    async (tx) => {
      // Claims take this lock before touching the credential and attempt rows.
      // Completion takes the same fence after the canonical capacity lock, so
      // a claim cannot hold a credential SHARE lock while waiting for an
      // attempt row that this transaction already owns.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`codex-reset-attempt:${input.attemptId}`}, 0))`,
      );
      const [current] = await tx
        .select()
        .from(schema.codexResetRedemptionAttempts)
        .where(
          and(
            eq(schema.codexResetRedemptionAttempts.accountId, input.accountId),
            eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
            eq(schema.codexResetRedemptionAttempts.id, input.attemptId),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) return { result: null, changed: false };
      if (current.status === "completed") {
        return {
          result: mapCodexResetRedemptionAttempt(current),
          changed: false,
        };
      }
      if (current.status !== "provider_started" || current.claimHolderId !== input.claimHolderId) {
        return { result: null, changed: false };
      }
      const completedAt = new Date();
      const [completed] = await tx
        .update(schema.codexResetRedemptionAttempts)
        .set({
          status: "completed",
          outcome: input.outcome,
          completedAt,
          claimHolderId: null,
          claimExpiresAt: null,
          lastFailureKind: null,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(schema.codexResetRedemptionAttempts.accountId, input.accountId),
            eq(schema.codexResetRedemptionAttempts.workspaceId, input.workspaceId),
            eq(schema.codexResetRedemptionAttempts.id, input.attemptId),
          ),
        )
        .returning();
      if (!completed) throw new Error("Codex redemption completion returned no row");
      const restoresCapacity = input.outcome === "reset" || input.outcome === "alreadyRedeemed";
      if (restoresCapacity) {
        await tx
          .update(schema.codexSubscriptionCredentials)
          .set({
            exhaustedUntil: null,
            exhaustedKind: null,
            exhaustedRevision: sql`${schema.codexSubscriptionCredentials.exhaustedRevision} + 1`,
          })
          .where(
            and(
              eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
              eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.codexSubscriptionCredentials.id, current.credentialId),
            ),
          );
      }
      await tx.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: current.subjectId,
            action: "codex.reset_credit.redemption.completed",
            targetType: "codex_reset_redemption_attempt",
            targetId: input.attemptId,
            metadata: { outcome: input.outcome },
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
      return {
        result: mapCodexResetRedemptionAttempt(completed),
        // A successful/already-applied upstream reset can make durable waiters
        // eligible immediately even when the local cooldown was already null.
        changed: restoresCapacity,
      };
    },
  );
}

export async function recordCodexAccountUsage(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
): Promise<boolean> {
  return (await recordCodexAccountUsageWithWakeTargets(db, workspaceId, credentialId, snapshot))
    .result;
}

export async function recordCodexAccountUsageWithWakeTargets(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
  authority?: CodexAcceptedCredentialAuthority,
): Promise<CodexCapacityMutationResult<boolean>> {
  return mutateCodexAccountUsage(db, workspaceId, credentialId, snapshot, authority);
}

export async function recordCodexAccountUsageForFinalization(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
  authority: CodexFinalizationUsageAuthority,
): Promise<CodexCapacityMutationResult<boolean>> {
  return mutateCodexAccountUsage(db, workspaceId, credentialId, snapshot, authority, authority);
}

async function codexFinalizationUsageCondition(
  tx: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
  authority: CodexFinalizationUsageAuthority,
): Promise<SQL | null> {
  // The normal fence supplies canonical control/workspace/session/turn/attempt
  // locks. Only this metadata writer admits its exact successfully settled owner.
  const fence = await lockTurnAttemptWriteFenceTx(tx, { ...authority, workspaceId });
  const { session, turn, attempt } = fence;
  if (!session || !turn || !attempt || !snapshot.checkedAt) return null;
  let authoritySnapshot;
  try {
    authoritySnapshot = assertSessionAuthoritySnapshot({
      attemptId: authority.attemptId,
      ...attempt,
    });
  } catch {
    return null;
  }
  const terminalOwner =
    ["completed", "failed"].includes(turn.status) &&
    turn.activeAttemptId === null &&
    turn.executionGeneration === authority.executionGeneration &&
    turn.sessionId === authority.sessionId &&
    turn.accountId === session.accountId &&
    attempt.accountId === session.accountId &&
    attempt.sessionId === session.id &&
    attempt.turnId === turn.id &&
    attempt.executionGeneration === authority.executionGeneration &&
    attempt.state === "closed" &&
    attempt.outcome === turn.status &&
    attempt.closedAt !== null &&
    snapshot.checkedAt <= attempt.closedAt &&
    snapshot.checkedAt >= attempt.startedAt &&
    session.status !== "cancelled" &&
    sessionAuthoritySnapshotMatchesSession(authoritySnapshot, session) &&
    (fence.allowed || (fence.reason !== "workspace_paused" && fence.reason !== "session_paused"));
  if (!fence.allowed && !terminalOwner) return null;
  const [interruption] = await tx
    .select({ id: schema.sessionAttemptInterruptions.id })
    .from(schema.sessionAttemptInterruptions)
    .where(
      and(
        eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
        eq(schema.sessionAttemptInterruptions.attemptId, authority.attemptId),
        inArray(schema.sessionAttemptInterruptions.state, ["pending", "delivered", "acknowledged"]),
      ),
    )
    .limit(1);
  if (interruption) return null;
  const leases = await tx.execute(sql`
    select turn_id from codex_credential_leases
    where account_id = ${session.accountId} and workspace_id = ${workspaceId}
      and turn_id = ${authority.turnId} and credential_id = ${credentialId}
      and holder_id = ${authority.holderId} and generation = ${authority.generation}
      and leased_until > clock_timestamp()
    for update
  `);
  if (!leases.length) return null;
  const source = await codexSourceForTurn(tx, workspaceId, turn.id, "disabled");
  if (source === "disabled") return null;
  return and(
    codexCredentialPoolCondition({ accountId: session.accountId, workspaceId, source }),
    eq(schema.codexSubscriptionCredentials.version, authority.credentialVersion),
    eq(schema.codexSubscriptionCredentials.status, "active"),
    // Old cleanup must not replace a fresher poll/header snapshot.
    sql`(${schema.codexSubscriptionCredentials.usageCheckedAt} is null or
      ${schema.codexSubscriptionCredentials.usageCheckedAt} <= ${snapshot.checkedAt.toISOString()}::timestamptz)`,
  )!;
}

async function mutateCodexAccountUsage(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
  authority?: CodexAcceptedCredentialAuthority,
  finalizationAuthority?: CodexFinalizationUsageAuthority,
): Promise<CodexCapacityMutationResult<boolean>> {
  return await withSessionCodexCapacityMutation(
    db,
    {
      workspaceId,
      reason: "codex_usage_refreshed",
      acceptedTurnId: authority?.turnId,
      mutationSource: "effective",
    },
    async (tx) => {
      const condition = finalizationAuthority
        ? await codexFinalizationUsageCondition(
            tx,
            workspaceId,
            credentialId,
            snapshot,
            finalizationAuthority,
          )
        : await codexCredentialUseCondition(tx, workspaceId, authority);
      if (!condition) return { result: false, changed: false };
      const [previous] = await tx
        .select({
          primaryUsedPercent: schema.codexSubscriptionCredentials.primaryUsedPercent,
          primaryResetAt: schema.codexSubscriptionCredentials.primaryResetAt,
          secondaryUsedPercent: schema.codexSubscriptionCredentials.secondaryUsedPercent,
          secondaryResetAt: schema.codexSubscriptionCredentials.secondaryResetAt,
          exhaustedUntil: schema.codexSubscriptionCredentials.exhaustedUntil,
          exhaustedKind: schema.codexSubscriptionCredentials.exhaustedKind,
          exhaustedRevision: schema.codexSubscriptionCredentials.exhaustedRevision,
          planType: schema.codexSubscriptionCredentials.planType,
          planEntitlementExclusion: schema.codexSubscriptionCredentials.planEntitlementExclusion,
        })
        .from(schema.codexSubscriptionCredentials)
        .where(and(eq(schema.codexSubscriptionCredentials.id, credentialId), condition))
        .for("update");
      if (!previous) {
        return { result: false, changed: false };
      }
      const clearQuotaCooldown =
        snapshot.checkedAt !== undefined &&
        Number.isSafeInteger(snapshot.clearQuotaCooldownRevision) &&
        snapshot.clearQuotaCooldownRevision === previous.exhaustedRevision &&
        previous.exhaustedKind === "quota" &&
        previous.exhaustedUntil !== null;
      // /wham/usage reports the account's current plan independently of its
      // quota windows (a Free account may return no windows at all).
      const observedPlanType =
        typeof snapshot.planType === "string" && snapshot.planType.trim().length > 0
          ? snapshot.planType.trim()
          : null;
      const planExclusionRetired =
        observedPlanType !== null &&
        previous.planType?.toLowerCase() !== observedPlanType.toLowerCase() &&
        readCodexPlanEntitlementExclusion(previous.planEntitlementExclusion) !== null;
      const updated = await tx
        .update(schema.codexSubscriptionCredentials)
        .set({
          ...(observedPlanType !== null
            ? codexPlanObservationSet(
                observedPlanType,
                snapshot.planCheckedAt ?? snapshot.checkedAt ?? new Date(),
              )
            : {}),
          ...(snapshot.checkedAt !== undefined
            ? {
                primaryUsedPercent: snapshot.primaryUsedPercent ?? null,
                primaryResetAt: snapshot.primaryResetAt ?? null,
                secondaryUsedPercent: snapshot.secondaryUsedPercent ?? null,
                secondaryResetAt: snapshot.secondaryResetAt ?? null,
                usageCheckedAt: snapshot.checkedAt,
              }
            : {}),
          ...(snapshot.resetCreditAvailableCount !== undefined
            ? {
                resetCreditAvailableCount: snapshot.resetCreditAvailableCount,
                resetCreditsCheckedAt: snapshot.resetCreditsCheckedAt ?? null,
              }
            : {}),
          ...(clearQuotaCooldown
            ? {
                exhaustedUntil: null,
                exhaustedKind: null,
                exhaustedRevision: sql`${schema.codexSubscriptionCredentials.exhaustedRevision} + 1`,
              }
            : {}),
          // NB: no `version` bump and no `updatedAt` touch — usage is non-credential
          // metadata and must NOT race the (id, version) refresh CAS in
          // recordCodexTokenRefresh / setCodexCredentialStatus.
        })
        .where(and(eq(schema.codexSubscriptionCredentials.id, credentialId), condition))
        .returning({ id: schema.codexSubscriptionCredentials.id });
      const rowUpdated = updated.length > 0;
      const timestampChanged = (before: Date | null, after: Date | null): boolean =>
        before?.getTime() !== after?.getTime();
      const capacityChanged =
        rowUpdated &&
        snapshot.checkedAt !== undefined &&
        (previous.primaryUsedPercent !== (snapshot.primaryUsedPercent ?? null) ||
          timestampChanged(previous.primaryResetAt, snapshot.primaryResetAt ?? null) ||
          previous.secondaryUsedPercent !== (snapshot.secondaryUsedPercent ?? null) ||
          timestampChanged(previous.secondaryResetAt, snapshot.secondaryResetAt ?? null) ||
          (clearQuotaCooldown && previous.exhaustedUntil! > snapshot.checkedAt));
      return {
        result: rowUpdated,
        changed: capacityChanged || (rowUpdated && planExclusionRetired),
      };
    },
  );
}

export async function getCodexRotationSettings(
  db: Database,
  workspaceId: string,
  acceptedTurnId?: string,
): Promise<CodexRotationSettings | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const source = await getWorkspaceCodexSubscriptionSourceScoped(scopedDb, workspaceId);
    if (acceptedTurnId) {
      source.effectiveSource = await codexSourceForTurn(
        scopedDb,
        workspaceId,
        acceptedTurnId,
        source.effectiveSource,
      );
    }
    if (source.effectiveSource === "disabled") return null;
    const [row] =
      source.effectiveSource === "organization"
        ? await scopedDb
            .select({
              activeCredentialId: schema.organizationCodexRotationSettings.activeCredentialId,
              rotationEnabled: schema.organizationCodexRotationSettings.rotationEnabled,
              rotationStrategy: schema.organizationCodexRotationSettings.rotationStrategy,
            })
            .from(schema.organizationCodexRotationSettings)
            .where(eq(schema.organizationCodexRotationSettings.accountId, source.accountId))
            .limit(1)
        : await scopedDb
            .select({
              activeCredentialId: schema.codexRotationSettings.activeCredentialId,
              rotationEnabled: schema.codexRotationSettings.rotationEnabled,
              rotationStrategy: schema.codexRotationSettings.rotationStrategy,
            })
            .from(schema.codexRotationSettings)
            .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
            .limit(1);
    if (row && source.effectiveSource === "organization") {
      const accounts = await listCodexAccountStatuses(scopedDb, workspaceId, acceptedTurnId);
      return {
        ...row,
        activeCredentialId: assignedConnectionDefault(row.activeCredentialId, accounts),
      };
    }
    return row ?? null;
  });
}

export async function ensureCodexRotationSettings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<void> {
  await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    await scopedDb
      .insert(schema.codexRotationSettings)
      .values({
        accountId,
        workspaceId,
      })
      .onConflictDoNothing({
        target: [schema.codexRotationSettings.workspaceId],
      });
  });
}

export async function setActiveCodexCredential(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    const [cred] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!cred) {
      return false;
    }
    const updated = await scopedDb
      .update(schema.codexRotationSettings)
      .set({ activeCredentialId: credentialId, updatedAt: new Date() })
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .returning({ id: schema.codexRotationSettings.id });
    return updated.length > 0;
  });
}

export async function setInitialActiveCodexCredential(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    const [cred] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          eq(schema.codexSubscriptionCredentials.id, credentialId),
        ),
      )
      .limit(1);
    if (!cred) return false;
    const rows = await scopedDb
      .update(schema.codexRotationSettings)
      .set({ activeCredentialId: credentialId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexRotationSettings.workspaceId, workspaceId),
          isNull(schema.codexRotationSettings.activeCredentialId),
        ),
      )
      .returning({ id: schema.codexRotationSettings.id });
    return rows.length > 0;
  });
}

export async function setCodexCredentialExhausted(
  db: Database,
  workspaceId: string,
  credentialId: string,
  until: Date | null,
  cooldownKind: CodexCredentialCooldownKind | null,
): Promise<boolean> {
  return (
    await setCodexCredentialExhaustedWithWakeTargets(
      db,
      workspaceId,
      credentialId,
      until,
      cooldownKind,
    )
  ).result;
}

export async function setCodexCredentialExhaustedWithWakeTargets(
  db: Database,
  workspaceId: string,
  credentialId: string,
  until: Date | null,
  cooldownKind: CodexCredentialCooldownKind | null,
): Promise<CodexCapacityMutationResult<boolean>> {
  if ((until === null) !== (cooldownKind === null)) {
    throw new Error("Codex cooldown timestamp and kind must be set or cleared together");
  }
  return await withCodexCapacityMutation(
    db,
    {
      workspaceId,
      reason: until === null ? "codex_cooldown_cleared" : "codex_cooldown_changed",
      mutationSource: "effective",
    },
    async (tx) => {
      const pool = await effectiveCodexCredentialPoolCondition(tx, workspaceId);
      if (!pool.condition) return { result: false, changed: false };
      const updated = await tx
        .update(schema.codexSubscriptionCredentials)
        .set({
          exhaustedUntil: until,
          exhaustedKind: cooldownKind,
          exhaustedRevision: sql`${schema.codexSubscriptionCredentials.exhaustedRevision} + 1`,
        })
        .where(and(eq(schema.codexSubscriptionCredentials.id, credentialId), pool.condition))
        .returning({ id: schema.codexSubscriptionCredentials.id });
      const changed = updated.length > 0;
      return { result: changed, changed };
    },
  );
}

export async function updateCodexRotationSettings(
  db: Database,
  workspaceId: string,
  patch: {
    rotationEnabled?: boolean;
    rotationStrategy?: CodexRotationStrategy;
  },
): Promise<CodexRotationSettings | null> {
  if (
    patch.rotationStrategy !== undefined &&
    !CODEX_ROTATION_STRATEGIES.includes(patch.rotationStrategy)
  ) {
    throw new Error(`invalid codex rotation strategy: ${patch.rotationStrategy}`);
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.rotationEnabled !== undefined) {
      set.rotationEnabled = patch.rotationEnabled;
    }
    if (patch.rotationStrategy !== undefined) {
      set.rotationStrategy = patch.rotationStrategy;
    }
    const [row] = await scopedDb
      .update(schema.codexRotationSettings)
      .set(set)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .returning({
        activeCredentialId: schema.codexRotationSettings.activeCredentialId,
        rotationEnabled: schema.codexRotationSettings.rotationEnabled,
        rotationStrategy: schema.codexRotationSettings.rotationStrategy,
      });
    return row ?? null;
  });
}

export async function renameCodexAccount(
  db: Database,
  workspaceId: string,
  credentialId: string,
  label: string | null,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ label, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

export async function getSessionCodexState(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionCodexState | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        pinnedCredentialId: schema.sessions.codexPinnedCredentialId,
        lastCredentialId: schema.sessions.codexLastCredentialId,
        pinSource: schema.sessions.codexPinSource,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      pinnedCredentialId: row.pinnedCredentialId,
      lastCredentialId: row.lastCredentialId,
      pinSource: (row.pinSource as CodexPinSource | null) ?? null,
    };
  });
}

export async function setSessionCodexPinInTransaction(
  db: SessionActivityDatabase,
  workspaceId: string,
  sessionId: string,
  pinnedCredentialId: string | null,
  source: CodexPinSource = "manual",
  options: SetSessionCodexPinOptions = {},
): Promise<boolean> {
  if (pinnedCredentialId !== null) {
    const pool = await effectiveCodexCredentialPoolCondition(db, workspaceId);
    if (!pool.condition) return false;
    const [cred] = await db
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(and(eq(schema.codexSubscriptionCredentials.id, pinnedCredentialId), pool.condition))
      .limit(1);
    if (!cred) {
      return false;
    }
  }
  const conditions = [
    eq(schema.sessions.workspaceId, workspaceId),
    eq(schema.sessions.id, sessionId),
  ];
  if (options.expected) {
    conditions.push(
      options.expected.pinnedCredentialId === null
        ? isNull(schema.sessions.codexPinnedCredentialId)
        : eq(schema.sessions.codexPinnedCredentialId, options.expected.pinnedCredentialId),
      options.expected.pinSource === null
        ? isNull(schema.sessions.codexPinSource)
        : eq(schema.sessions.codexPinSource, options.expected.pinSource),
    );
  }
  const updated = await db
    .update(schema.sessions)
    .set({
      codexPinnedCredentialId: pinnedCredentialId,
      // Source travels with the pin: a cleared pin (null) clears the source too.
      codexPinSource: pinnedCredentialId === null ? null : source,
      // Only an explicit session account switch is conversation activity.
      ...(source === "manual" ? { updatedAt: new Date() } : {}),
    })
    .where(and(...conditions))
    .returning({ id: schema.sessions.id });
  return updated.length > 0;
}

export async function switchSessionCodexAccount(
  db: Database,
  input: { workspaceId: string; sessionId: string; credentialId: string | null; subjectId: string },
) {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (scopedDb) => {
    await lockWorkspaceCodexSubscriptionSource(scopedDb, input.workspaceId);
    await captureLegacyCodexTurnSources(scopedDb, input.workspaceId);
    const [observed] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .limit(1);
    const acceptedTurnId =
      observed?.status === "waiting_capacity" ? (observed.activeTurnId ?? undefined) : undefined;
    return await mutateCodexCapacityInTransaction<
      {
        changed: boolean;
        appliedTo: "waiting_turn" | "next_turn";
        events: SessionEvent[];
      },
      SessionActivityDatabase
    >(
      scopedDb,
      {
        workspaceId: input.workspaceId,
        reason: "codex_manual_session_pin_changed",
        acceptedTurnId,
        mutationSource: "effective",
      },
      async (tx) => {
        const rotation = await lockExistingCodexRotationSettingsForCapacity(
          tx,
          input.workspaceId,
          acceptedTurnId,
        );
        const events: SessionEvent[] = [];
        let appliedTo: "waiting_turn" | "next_turn" = "next_turn";
        const locks = await lockSessionEventWriteRows(tx, {
          workspaceId: input.workspaceId,
          controlLock: "none",
          sessionIds: [input.sessionId],
        });
        const session = locks.sessions[0];
        // The source advisory serializes allocation, but settlement can still move
        // the session. Never apply a choice validated for a different boundary.
        if (
          !session ||
          session.status !== observed?.status ||
          session.activeTurnId !== observed?.activeTurnId
        ) {
          return { result: { changed: false, appliedTo, events }, changed: false };
        }
        if (input.credentialId !== null) {
          if (!rotation || rotation.source === "disabled")
            return { result: { changed: false, appliedTo, events }, changed: false };
          const [credential] = await tx
            .select({ id: schema.codexSubscriptionCredentials.id })
            .from(schema.codexSubscriptionCredentials)
            .where(
              and(
                eq(schema.codexSubscriptionCredentials.id, input.credentialId),
                codexCredentialPoolCondition({
                  accountId: session.accountId,
                  workspaceId: input.workspaceId,
                  source: rotation.source,
                }),
              ),
            )
            .limit(1);
          if (!credential) return { result: { changed: false, appliedTo, events }, changed: false };
        }
        if (session.status === "waiting_capacity" && session.activeTurnId) {
          const [turn] = await tx
            .select()
            .from(schema.sessionTurns)
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, input.workspaceId),
                eq(schema.sessionTurns.sessionId, input.sessionId),
                eq(schema.sessionTurns.id, session.activeTurnId),
              ),
            )
            .for("update");
          const [waiter] = await tx
            .select()
            .from(schema.codexCapacityWaiters)
            .where(
              and(
                eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
                eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
                eq(schema.codexCapacityWaiters.status, "waiting"),
              ),
            )
            .for("update");
          if (
            turn?.status === "waiting_capacity" &&
            turn.activeAttemptId === null &&
            waiter &&
            waiter.blockedTurnId === turn.id &&
            waiter.blockedTurnGeneration === turn.executionGeneration
          ) {
            const accepted = readCodexCredentialPolicySnapshotV1(turn.metadata);
            if (accepted.kind === "valid") {
              // Never use an explicit pin override to cross the accepted authority/pool boundary.
              if (
                !rotation ||
                (accepted.policy.source && accepted.policy.source !== rotation.source)
              ) {
                throw new Error("Cannot switch a waiting Codex turn across credential sources");
              }
              const policy = {
                ...accepted.policy,
                source: rotation.source,
                pinnedCredentialId: input.credentialId,
                pinSource: input.credentialId === null ? null : ("manual" as const),
                // Auto explicitly requests the current defaults within the SAME accepted pool.
                ...(input.credentialId === null
                  ? {
                      activeCredentialId: rotation.activeCredentialId,
                      rotationEnabled: rotation.rotationEnabled,
                      rotationStrategy: rotation.rotationStrategy,
                      lastCredentialId: null,
                    }
                  : {}),
              };
              await tx
                .update(schema.sessionTurns)
                .set({
                  metadata: metadataWithCodexCredentialPolicySnapshotV1(turn.metadata, policy),
                  version: turn.version + 1,
                  updatedAt: new Date(),
                })
                .where(eq(schema.sessionTurns.id, turn.id));
            }
            appliedTo = "waiting_turn";
          }
        }
        await tx
          .update(schema.sessions)
          .set({
            codexPinnedCredentialId: input.credentialId,
            codexPinSource: input.credentialId === null ? null : "manual",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values(
            withLosslessContentWriteVersion(
              [
                {
                  accountId: session.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: session.lastSequence + 1,
                  type: "codex.account.selection.changed",
                  payload: {
                    credentialId: input.credentialId,
                    appliedTo,
                    turnId: appliedTo === "waiting_turn" ? session.activeTurnId : null,
                    subjectId: input.subjectId,
                  },
                  // This is a user control receipt, not output from a running attempt.
                  occurredAt: new Date(),
                },
              ],
              "payload",
              "payloadCodecVersion",
            ),
          )
          .returning();
        await tx
          .update(schema.sessions)
          .set({ lastSequence: session.lastSequence + 1 })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        events.push(...inserted.map(mapEvent));
        return { result: { changed: true, appliedTo, events }, changed: true };
      },
    );
  });
}

export async function setSessionCodexPin(
  db: Database,
  workspaceId: string,
  sessionId: string,
  pinnedCredentialId: string | null,
  source: CodexPinSource = "manual",
  options: SetSessionCodexPinOptions = {},
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(db, workspaceId, (tx) =>
    setSessionCodexPinInTransaction(
      tx,
      workspaceId,
      sessionId,
      pinnedCredentialId,
      source,
      options,
    ),
  );
}

export async function recordSessionCodexSelectionForTurnAttempt(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    credentialId: string;
    strategy: string;
    reusedLease: boolean;
    pinnedCredentialId: string | null;
    pinSource: "manual" | "policy" | null;
    eligibleCount: number;
    connectedCount: number;
  },
): Promise<{ events: SessionEvent[]; diagnostics: ReturnType<typeof codexSelectionDiagnostics> }> {
  return await withWorkspaceSessionEventActivityRls(db, input.workspaceId, true, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      executionGeneration: input.executionGeneration,
      attemptId: input.attemptId,
      sessionLock: "no_key_update",
    });
    if (!fence.allowed || !fence.session) throw new CodexCredentialLeaseAttemptFencedError();
    const key = `opengeni:codex-selection:${input.attemptId}`;
    const prior = await tx
      .select()
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, input.workspaceId),
          eq(schema.sessionEvents.sessionId, input.sessionId),
          inArray(schema.sessionEvents.clientEventId, [key, `${key}:switch`]),
        ),
      )
      .orderBy(asc(schema.sessionEvents.sequence));
    if (prior.length) {
      const receipt = prior.find((event) => event.type === "codex.credential.selected");
      if (!receipt) throw new Error("Codex selection receipt missing");
      const payload = sessionEventPayloadRecord(receipt.payload, receipt.payloadCodecVersion);
      if (payload.credentialId !== input.credentialId)
        throw new Error("An attempt cannot record two different Codex selections");
      return {
        events: prior.map(mapEvent),
        diagnostics: {
          transition: payload.transition,
          source: payload.source,
          reason: payload.reason,
        } as ReturnType<typeof codexSelectionDiagnostics>,
      };
    }
    const previousCredentialId = fence.session.codexLastCredentialId;
    const diagnostics = codexSelectionDiagnostics({ ...input, previousCredentialId });
    const events: AppendEventInput[] = [];
    if (previousCredentialId !== null && previousCredentialId !== input.credentialId) {
      events.push({
        type: "codex.account.switched",
        clientEventId: `${key}:switch`,
        payload: {
          fromAccountId: previousCredentialId,
          toAccountId: input.credentialId,
          reason: diagnostics.source === "manual_pin" ? "manual" : "rotation",
        },
      });
    }
    events.push({
      type: "codex.credential.selected",
      clientEventId: key,
      payload: {
        credentialId: input.credentialId,
        strategy: input.strategy,
        ...diagnostics,
        previousCredentialId,
        eligibleCount: input.eligibleCount,
        connectedCount: input.connectedCount,
        reused: input.reusedLease,
      },
    });
    await tx
      .update(schema.sessions)
      .set({ codexLastCredentialId: input.credentialId })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      );
    const appended = await appendSessionEventsForTurnAttempt(
      tx,
      input.workspaceId,
      input.sessionId,
      input.turnId,
      input.executionGeneration,
      input.attemptId,
      events,
    );
    if (!appended.accepted) throw new CodexCredentialLeaseAttemptFencedError();
    return { events: appended.events, diagnostics };
  });
}

export async function recordSessionActiveCodexCredential(
  db: Database,
  workspaceId: string,
  sessionId: string,
  credentialId: string,
): Promise<void> {
  await withWorkspaceSessionActivityRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.sessions)
      .set({ codexLastCredentialId: credentialId })
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.id, sessionId),
          sql`${schema.sessions.codexLastCredentialId} is distinct from ${credentialId}`,
        ),
      );
  });
}

export async function disconnectCodexAccount(
  db: Database,
  workspaceId: string,
  credentialId: string,
  actorSubjectId: string | null = null,
): Promise<{
  removed: boolean;
  newActiveCredentialId: string | null;
  blockedByUnresolvedRedemption: boolean;
}> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${workspaceId}`}, 0))`,
    );
    const [appsSettings] = await scopedDb
      .select()
      .from(schema.codexAppsSettings)
      .where(eq(schema.codexAppsSettings.workspaceId, workspaceId))
      .for("update")
      .limit(1);
    const [credential] = await scopedDb
      .select({
        id: schema.codexSubscriptionCredentials.id,
        accountId: schema.codexSubscriptionCredentials.accountId,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .for("update")
      .limit(1);
    const [settingsBefore] = await scopedDb
      .select({
        activeCredentialId: schema.codexRotationSettings.activeCredentialId,
      })
      .from(schema.codexRotationSettings)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .limit(1);
    if (!credential) {
      return {
        removed: false,
        newActiveCredentialId: settingsBefore?.activeCredentialId ?? null,
        blockedByUnresolvedRedemption: false,
      };
    }
    const [unresolved] = await scopedDb
      .select({ id: schema.codexResetRedemptionAttempts.id })
      .from(schema.codexResetRedemptionAttempts)
      .where(
        and(
          eq(schema.codexResetRedemptionAttempts.workspaceId, workspaceId),
          eq(schema.codexResetRedemptionAttempts.credentialId, credentialId),
          eq(schema.codexResetRedemptionAttempts.status, "provider_started"),
        ),
      )
      .limit(1);
    if (unresolved) {
      return {
        removed: false,
        newActiveCredentialId: settingsBefore?.activeCredentialId ?? null,
        blockedByUnresolvedRedemption: true,
      };
    }
    if (appsSettings?.credentialId === credentialId) {
      const version = appsSettings.version + 1;
      await scopedDb
        .update(schema.codexAppsSettings)
        .set({
          credentialId: null,
          version,
          designatedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.codexAppsSettings.id, appsSettings.id));
      await scopedDb.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: credential.accountId,
            workspaceId,
            subjectId: actorSubjectId,
            action: "codex_apps.cleared_on_disconnect",
            targetType: "codex_subscription_credential",
            targetId: credentialId,
            metadata: { version },
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
    }
    const removedRows = await scopedDb
      .delete(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    // The FK SET NULL already cleared the pointer if we deleted the active row.
    const [settingsRow] = await scopedDb
      .select({
        activeCredentialId: schema.codexRotationSettings.activeCredentialId,
      })
      .from(schema.codexRotationSettings)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .limit(1);
    if (removedRows.length === 0) {
      return {
        removed: false,
        newActiveCredentialId: settingsRow?.activeCredentialId ?? null,
        blockedByUnresolvedRedemption: false,
      };
    }
    let newActive = settingsRow?.activeCredentialId ?? null;
    if (newActive === null) {
      const [next] = await scopedDb
        .select({ id: schema.codexSubscriptionCredentials.id })
        .from(schema.codexSubscriptionCredentials)
        .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
        .orderBy(desc(schema.codexSubscriptionCredentials.createdAt))
        .limit(1);
      newActive = next?.id ?? null;
      if (settingsRow) {
        await scopedDb
          .update(schema.codexRotationSettings)
          .set({ activeCredentialId: newActive, updatedAt: new Date() })
          .where(eq(schema.codexRotationSettings.workspaceId, workspaceId));
      }
    }
    return {
      removed: true,
      newActiveCredentialId: newActive,
      blockedByUnresolvedRedemption: false,
    };
  });
}

export async function disconnectAllCodexAccounts(
  db: Database,
  workspaceId: string,
  actorSubjectId: string | null = null,
): Promise<{ removed: number; blockedCredentialIds: string[] }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${workspaceId}`}, 0))`,
    );
    const [appsSettings] = await scopedDb
      .select()
      .from(schema.codexAppsSettings)
      .where(eq(schema.codexAppsSettings.workspaceId, workspaceId))
      .for("update")
      .limit(1);
    const credentials = await scopedDb
      .select({
        id: schema.codexSubscriptionCredentials.id,
        accountId: schema.codexSubscriptionCredentials.accountId,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .orderBy(asc(schema.codexSubscriptionCredentials.id))
      .for("update");
    if (credentials.length === 0) return { removed: 0, blockedCredentialIds: [] };
    const blocked = await scopedDb
      .selectDistinct({
        credentialId: schema.codexResetRedemptionAttempts.credentialId,
      })
      .from(schema.codexResetRedemptionAttempts)
      .where(
        and(
          eq(schema.codexResetRedemptionAttempts.workspaceId, workspaceId),
          eq(schema.codexResetRedemptionAttempts.status, "provider_started"),
        ),
      );
    if (blocked.length > 0) {
      return {
        removed: 0,
        blockedCredentialIds: blocked.map((row) => row.credentialId).sort(),
      };
    }
    if (appsSettings?.credentialId) {
      const version = appsSettings.version + 1;
      await scopedDb
        .update(schema.codexAppsSettings)
        .set({
          credentialId: null,
          version,
          designatedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.codexAppsSettings.id, appsSettings.id));
      await scopedDb.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: credentials[0]!.accountId,
            workspaceId,
            subjectId: actorSubjectId,
            action: "codex_apps.cleared_on_disconnect",
            targetType: "codex_subscription_credential",
            targetId: appsSettings.credentialId,
            metadata: { version },
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
    }
    const rows = await scopedDb
      .delete(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return { removed: rows.length, blockedCredentialIds: [] };
  });
}

const SESSION_INPUT_WAIT_PERSON_TURN_SOURCES = [
  "user",
  "api",
  "compaction",
] as const satisfies readonly SessionTurnSource[];

const SESSION_INPUT_WAIT_RETIRING_UPDATE_KINDS = (
  Object.entries(SESSION_SYSTEM_UPDATE_WAKE_CLASS) as Array<[SessionSystemUpdateKind, string]>
)
  .filter(([, wakeClass]) => wakeClass === "immediate")
  .map(([kind]) => kind);

function sessionInputWaitDecidingTurnSql(
  turn: {
    id: SQLWrapper;
    source: SQLWrapper;
    workspaceId: SQLWrapper;
    sessionId: SQLWrapper;
    finishedAt: SQLWrapper;
    metadata: SQLWrapper;
  },
  waitTurnId: SQLWrapper | string,
): SQL {
  const consumedAnswersKey = CONSUMED_CHILD_ANSWERS_METADATA_KEY;
  const consumedAnswers = (metadata: SQLWrapper) =>
    sql`jsonb_array_elements(case when jsonb_typeof(${metadata} -> ${consumedAnswersKey}) = 'array'
      then ${metadata} -> ${consumedAnswersKey} else '[]'::jsonb end)`;
  // By its unique (workspace, id) key: the declaring turn is this session's.
  const waitDeclaredAt = sql`(select declaring.finished_at from ${schema.sessionTurns} declaring
    where declaring.workspace_id = ${turn.workspaceId} and declaring.id = ${waitTurnId})`;
  return sql`(${turn.id} = ${waitTurnId} or ${turn.source} not in (${sql.join(
    SESSION_INPUT_WAIT_PERSON_TURN_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )}) or exists (
    select 1 from ${schema.sessionSystemUpdates} consumed
    where consumed.workspace_id = ${turn.workspaceId}
      and consumed.session_id = ${turn.sessionId}
      and consumed.state = 'delivered'
      and consumed.delivered_turn_id = ${turn.id}
      and consumed.kind in (${sql.join(
        SESSION_INPUT_WAIT_RETIRING_UPDATE_KINDS.map((kind) => sql`${kind}`),
        sql`, `,
      )})
  ) or (
    ${turn.finishedAt} >= ${waitDeclaredAt}
    and exists (
      select 1 from ${schema.sessionSystemUpdates} consumed_read
      cross join lateral ${consumedAnswers(turn.metadata)} consumed_answer
      where consumed_read.workspace_id = ${turn.workspaceId}
        and consumed_read.session_id = ${turn.sessionId}
        and consumed_read.state = 'superseded'
        and consumed_read.kind = 'child_terminal_result'
        and consumed_answer ->> 'childSessionId' = consumed_read.payload ->> 'childSessionId'
        and (
          consumed_answer -> 'sequence' = consumed_read.payload -> 'finalAnswer' -> 'sequence'
          or consumed_read.payload -> 'finalAnswer' -> 'goalContinuations'
            @> jsonb_build_array(jsonb_build_object('sequence', consumed_answer -> 'sequence'))
          or consumed_read.payload -> 'finalAnswer' -> 'omittedSequences'
            @> jsonb_build_array(consumed_answer -> 'sequence')
        )
        and not exists (
          select 1 from ${schema.sessionTurns} earlier
          cross join lateral ${consumedAnswers(sql`earlier.metadata`)} earlier_answer
          where earlier.workspace_id = ${turn.workspaceId}
            and earlier.session_id = ${turn.sessionId}
            and earlier.finished_at <= ${waitDeclaredAt}
            and earlier_answer ->> 'childSessionId' = consumed_answer ->> 'childSessionId'
            and earlier_answer -> 'sequence' = consumed_answer -> 'sequence'
            and exists (
              select 1 from ${schema.sessionTurnAttempts} earlier_attempt
              where earlier_attempt.workspace_id = earlier.workspace_id
                and earlier_attempt.id = case when earlier_answer ->> 'attemptId' ~ ${UUID_TEXT_PATTERN_SQL}
                  then (earlier_answer ->> 'attemptId')::uuid end
                and earlier_attempt.session_id = earlier.session_id
                and earlier_attempt.turn_id = earlier.id
                and earlier_attempt.outcome = 'completed'
            )
        )
    )
  ))`;
}

async function transactionNow(tx: Database): Promise<Date> {
  const rows = await rawRows<{ now: string | Date }>(tx, sql`select now() as now`);
  const value = rows[0]?.now;
  if (value === undefined) throw new Error("Failed to read the transaction clock");
  return value instanceof Date ? value : new Date(value);
}

async function turnHasFailureCodeTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  code: string,
): Promise<boolean> {
  const [failure] = await tx
    .select({ id: schema.sessionEvents.id })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.turnId, turnId),
        eq(schema.sessionEvents.type, "turn.failed"),
        sql`${schema.sessionEvents.payload} ->> 'code' = ${code}`,
      ),
    )
    .limit(1);
  return Boolean(failure);
}

async function latestFinishedTurnHasFailureCodeTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  code: string,
): Promise<boolean> {
  const [latestFinished] = await tx
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        sql`${schema.sessionTurns.finishedAt} is not null`,
      ),
    )
    .orderBy(
      desc(schema.sessionTurns.finishedAt),
      desc(schema.sessionTurns.position),
      desc(schema.sessionTurns.createdAt),
    )
    .limit(1);
  return latestFinished
    ? await turnHasFailureCodeTx(tx, workspaceId, sessionId, latestFinished.id, code)
    : false;
}

const UUID_TEXT_PATTERN_SQL =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

async function nextSessionAttemptAwaitingQuiescence(
  db: Database,
  workspaceId: string,
  sessionId: string,
  writerMode: "physical" | "inference" = "physical",
): Promise<{
  attemptId: string;
} | null> {
  const [row] = await db
    .select({
      attemptId: schema.sessionTurnAttempts.id,
    })
    .from(schema.sessionTurnAttempts)
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
        eq(schema.sessionTurnAttempts.sessionId, sessionId),
        eq(schema.sessionTurnAttempts.state, "closed"),
        isNull(schema.sessionTurnAttempts.quiescedAt),
        sql`(
          ${sessionAttemptPendingWritersSql(sql`${schema.sessionTurnAttempts}`, writerMode)}
          or exists (
            select 1
            from session_attempt_interruptions interruption
            where interruption.workspace_id = ${schema.sessionTurnAttempts.workspaceId}
              and interruption.session_id = ${schema.sessionTurnAttempts.sessionId}
              and interruption.attempt_id = ${schema.sessionTurnAttempts.id}
              and interruption.state in ('settled', 'rejected_stale')
          )
          or (
            ${schema.sessionTurnAttempts.outcome} = 'interrupted_recoverable'
            and not exists (
              select 1
              from session_turn_attempts successor
              where successor.account_id = ${schema.sessionTurnAttempts.accountId}
                and successor.workspace_id = ${schema.sessionTurnAttempts.workspaceId}
                and successor.session_id = ${schema.sessionTurnAttempts.sessionId}
                and (
                  successor.started_at > ${schema.sessionTurnAttempts.startedAt}
                  or (
                    successor.started_at = ${schema.sessionTurnAttempts.startedAt}
                    and successor.id > ${schema.sessionTurnAttempts.id}
                  )
                )
            )
            and exists (
              select 1
              from session_events event
              where event.account_id = ${schema.sessionTurnAttempts.accountId}
                and event.workspace_id = ${schema.sessionTurnAttempts.workspaceId}
                and event.session_id = ${schema.sessionTurnAttempts.sessionId}
                and event.turn_id = ${schema.sessionTurnAttempts.turnId}
                and event.turn_attempt_id = ${schema.sessionTurnAttempts.id}
                and event.type = 'turn.recovery.requested'
            )
          )
        )`,
      ),
    )
    .orderBy(asc(schema.sessionTurnAttempts.closedAt), asc(schema.sessionTurnAttempts.id))
    .limit(1);
  return row ?? null;
}

async function pausedSessionAttemptAwaitingRecoveryProjection(
  db: Database,
  workspaceId: string,
  sessionId: string,
  activeTurnId: string,
): Promise<{ attemptId: string } | null> {
  const [row] = await db
    .select({ attemptId: schema.sessionTurnAttempts.id })
    .from(schema.sessionTurnAttempts)
    .innerJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionTurns.workspaceId, schema.sessionTurnAttempts.workspaceId),
        eq(schema.sessionTurns.id, schema.sessionTurnAttempts.turnId),
      ),
    )
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
        eq(schema.sessionTurnAttempts.sessionId, sessionId),
        eq(schema.sessionTurnAttempts.turnId, activeTurnId),
        eq(schema.sessionTurnAttempts.state, "closed"),
        eq(schema.sessionTurnAttempts.outcome, "interrupted_recoverable"),
        isNotNull(schema.sessionTurnAttempts.quiescedAt),
        eq(schema.sessionTurns.status, "recovering"),
        isNull(schema.sessionTurns.activeAttemptId),
        // Provider recovery closes an attempt through its recovery-request
        // event, not an interruption row. Match the receipt transaction's two
        // evidence paths without borrowing an event from another attempt.
        sql`(exists (
          select 1 from session_attempt_interruptions interruption
          where interruption.workspace_id = ${schema.sessionTurnAttempts.workspaceId}
            and interruption.session_id = ${schema.sessionTurnAttempts.sessionId}
            and interruption.attempt_id = ${schema.sessionTurnAttempts.id}
            and interruption.state in ('settled', 'rejected_stale')
        ) or exists (
          select 1 from session_events event
          where event.account_id = ${schema.sessionTurnAttempts.accountId}
            and event.workspace_id = ${schema.sessionTurnAttempts.workspaceId}
            and event.session_id = ${schema.sessionTurnAttempts.sessionId}
            and event.turn_id = ${schema.sessionTurnAttempts.turnId}
            and event.turn_attempt_id = ${schema.sessionTurnAttempts.id}
            and event.type = 'turn.recovery.requested'
        ))`,
      ),
    )
    .orderBy(desc(schema.sessionTurnAttempts.startedAt), desc(schema.sessionTurnAttempts.id))
    .limit(1);
  return row ?? null;
}

function passiveCommandNoticeSql() {
  return sql<boolean>`(${schema.sessionSystemUpdates.kind} = 'background_command_result'
    and ${schema.sessionSystemUpdates.payload} ->> 'state' = 'lost'
    and ${schema.sessionSystemUpdates.payload} ->> 'reason' = ${IDLE_COMMAND_CONTAINMENT_REASON})`;
}

async function pendingSystemUpdateWakeClassesTx(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{ immediate: boolean; deferred: boolean; command: boolean }> {
  const rows = await db
    .selectDistinct({
      kind: schema.sessionSystemUpdates.kind,
      passive: passiveCommandNoticeSql(),
    })
    .from(schema.sessionSystemUpdates)
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, sessionId),
        eq(schema.sessionSystemUpdates.state, "pending"),
      ),
    );
  let immediate = false;
  let deferred = false;
  let command = false;
  for (const row of rows) {
    if (row.kind === "background_command_result") {
      if (!row.passive) command = true;
      continue;
    }
    const wakeClass =
      SESSION_SYSTEM_UPDATE_WAKE_CLASS[row.kind as SessionSystemUpdateKind] ?? "immediate";
    if (wakeClass === "deferred") deferred = true;
    else immediate = true;
  }
  return { immediate, deferred, command };
}

async function sessionInputWaitStateTx(
  db: Database,
  workspaceId: string,
  sessionId: string,
  wait: {
    inputWaitTurnId: string | null;
    inputWaitUntil: Date | null;
  },
): Promise<{ disposition: "none" | "held" | "timeout" | "superseded" }> {
  if (!wait.inputWaitTurnId || !wait.inputWaitUntil) {
    return { disposition: "none" };
  }
  const [decidingTurn] = await db
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        sql`${schema.sessionTurns.finishedAt} is not null`,
        sessionInputWaitDecidingTurnSql(schema.sessionTurns, wait.inputWaitTurnId),
      ),
    )
    .orderBy(
      desc(schema.sessionTurns.finishedAt),
      desc(schema.sessionTurns.position),
      desc(schema.sessionTurns.createdAt),
    )
    .limit(1);
  if (decidingTurn?.id !== wait.inputWaitTurnId) {
    return { disposition: "superseded" };
  }
  const dbNow = await transactionNow(db);
  return {
    disposition: wait.inputWaitUntil.getTime() <= dbNow.getTime() ? "timeout" : "held",
  };
}

export async function peekSessionWork(
  db: Database,
  workspaceId: string,
  sessionId: string,
  includeAdmissionFence = false,
  observerAccountId?: string,
): Promise<SessionWorkPeek> {
  const observe = async (scopedDb: Database): Promise<SessionWorkPeek> => {
    // An observer cannot distinguish absent rows from rows hidden by RLS.
    // Do not infer deletion or settle business state from either condition.
    if (observerAccountId) {
      const [visible] = await scopedDb
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
        .limit(1);
      if (!visible) return { kind: "unavailable" };
    }
    const effectiveControl = await evaluateSessionControl(scopedDb, workspaceId, sessionId, {
      lock: "share",
    });
    const [session] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!session) return { kind: observerAccountId ? "unavailable" : "idle" };
    // Pure event appends can leave the wide session projection behind. Admission
    // settlement fences against the allocation cursor, so observe that same
    // authority here without taking a writer lock during this advisory peek.
    let admissionSequence = session.lastSequence;
    if (includeAdmissionFence) {
      const [cursor] = await scopedDb
        .select()
        .from(schema.sessionEventCursors)
        .where(
          and(
            eq(schema.sessionEventCursors.accountId, session.accountId),
            eq(schema.sessionEventCursors.workspaceId, workspaceId),
            eq(schema.sessionEventCursors.sessionId, sessionId),
          ),
        )
        .limit(1);
      if (!cursor || cursor.lastSequence < session.lastSequence) {
        throw new SessionControlInvariantError(
          `Session admission cursor is missing or behind projection for session ${sessionId}`,
        );
      }
      admissionSequence = cursor.lastSequence;
    }
    const fence = includeAdmissionFence
      ? {
          admissionFence: {
            lastSequence: admissionSequence,
            controlVersion: effectiveControl.controlVersion,
          },
        }
      : {};
    const runnable = { kind: "runnable", ...fence } as const;
    const [interruption] = await scopedDb
      .select({ attemptId: schema.sessionAttemptInterruptions.attemptId })
      .from(schema.sessionAttemptInterruptions)
      .where(
        and(
          eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
          eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
          inArray(schema.sessionAttemptInterruptions.state, [
            "pending",
            "delivered",
            "acknowledged",
          ]),
        ),
      )
      .orderBy(
        asc(schema.sessionAttemptInterruptions.requestedAt),
        asc(schema.sessionAttemptInterruptions.id),
      )
      .limit(1);
    if (interruption) {
      return {
        kind: "interruption-pending",
        attemptId: interruption.attemptId,
      };
    }
    // Physical quiescence finishes an already-accepted interruption; it is not
    // new session work. Reconcile the missing receipt even while control stays
    // paused, otherwise the pause itself can strand this session and every
    // ancestor behind a permanent `settlement: stopping` projection.
    const awaitingQuiescence = await nextSessionAttemptAwaitingQuiescence(
      scopedDb,
      workspaceId,
      sessionId,
      "inference",
    );
    if (awaitingQuiescence) {
      return {
        kind: "cancellation-wait",
        attemptId: awaitingQuiescence.attemptId,
      };
    }

    if (effectiveControl.state !== "active") {
      // A receipt may already be durable while an older workflow/image left
      // the paused session's public status at `recovering`. Route that exact
      // attempt through the same DB-only reconciliation activity. The activity
      // skips Temporal inspection for a quiesced receipt, parks only the
      // session projection, and preserves the logical turn for Resume.
      if (
        effectiveControl.settlement === null &&
        session.status === "recovering" &&
        session.activeTurnId
      ) {
        const awaitingProjection = await pausedSessionAttemptAwaitingRecoveryProjection(
          scopedDb,
          workspaceId,
          sessionId,
          session.activeTurnId,
        );
        if (awaitingProjection) {
          return {
            kind: "cancellation-wait",
            attemptId: awaitingProjection.attemptId,
          };
        }
      }
      return { kind: "idle" };
    }

    if (session.admissionBlock) return { kind: "admission-blocked" };

    // A core Codex waiter (M3) is the only waiter written after the Codex
    // cutover; it keeps the legacy Codex reference shape, so the workflow
    // waits on it exactly as on a legacy waiter. A row that no longer belongs
    // to the session's active waiting turn becomes an immediate check, whose
    // reconcile deletes it, rather than a sleep until its next check.
    const coreCapacityWait = await readSubscriptionCoreCodexWaiterInTransaction(scopedDb, {
      workspaceId,
      sessionId,
    });
    if (coreCapacityWait) {
      return {
        kind: "capacity-wait",
        ref: subscriptionCoreCodexCapacityWaitRef(coreCapacityWait),
      };
    }

    const [capacityWait] = await scopedDb
      .select()
      .from(schema.codexCapacityWaiters)
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.sessionId, sessionId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      )
      .limit(1);
    if (capacityWait) {
      return {
        kind: "capacity-wait",
        ref: {
          waiterId: capacityWait.id,
          generation: capacityWait.generation,
          nextCheckAt:
            capacityWait.wakeRevision > capacityWait.observedWakeRevision
              ? new Date(0).toISOString()
              : capacityWait.nextCheckAt.toISOString(),
          wakeRevision: capacityWait.wakeRevision,
        },
      };
    }

    const xaiCapacityWait = await getXaiCapacityWaitForSessionInTransaction(
      scopedDb,
      workspaceId,
      sessionId,
    );
    const claudeCapacityWait = await getClaudeCapacityWaitForSessionInTransaction(
      scopedDb,
      workspaceId,
      sessionId,
    );
    if (xaiCapacityWait) {
      return {
        kind: "capacity-wait",
        ref: {
          provider: "xai",
          waiterId: xaiCapacityWait.id,
          generation: xaiCapacityWait.generation,
          nextCheckAt:
            xaiCapacityWait.wakeRevision > xaiCapacityWait.observedWakeRevision
              ? new Date(0).toISOString()
              : xaiCapacityWait.nextCheckAt.toISOString(),
          wakeRevision: xaiCapacityWait.wakeRevision,
        },
      };
    }

    if (claudeCapacityWait) {
      return {
        kind: "capacity-wait",
        ref: {
          provider: "claude",
          waiterId: claudeCapacityWait.id,
          generation: claudeCapacityWait.generation,
          nextCheckAt:
            claudeCapacityWait.wakeRevision > claudeCapacityWait.observedWakeRevision
              ? new Date(0).toISOString()
              : claudeCapacityWait.nextCheckAt.toISOString(),
          wakeRevision: claudeCapacityWait.wakeRevision,
        },
      };
    }

    if (session.activeTurnId) {
      const [turn] = await scopedDb
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, sessionId),
            eq(schema.sessionTurns.id, session.activeTurnId),
          ),
        )
        .limit(1);
      if (!turn) {
        throw new Error(
          `Session ${sessionId} points to missing active turn ${session.activeTurnId}`,
        );
      }
      if (turn.status === "recovering" || turn.status === "waiting_capacity") {
        const setupUnknown = sandboxSetupOutcomeUnknownFromTurnMetadata(turn.metadata);
        if (turn.status === "recovering" && setupUnknown) {
          // Existing workflow releases already park this wire kind. Do not
          // introduce a new peek kind that an older control worker could
          // mistake for runnable work during a rolling deployment.
          return {
            kind: "admission-blocked",
            reason: "sandbox_setup_outcome_unknown",
            ref: setupUnknown,
          };
        }
        const setupExhausted = sandboxSetupRecoveryExhaustedFromTurnMetadata(turn.metadata);
        if (turn.status === "recovering" && setupExhausted) {
          return {
            kind: "admission-blocked",
            reason: "sandbox_setup_recovery_exhausted",
            ref: setupExhausted,
          };
        }
        const lifecycleWait = sandboxLifecycleWaitFromTurnMetadata(turn.metadata);
        if (turn.status === "recovering" && lifecycleWait) {
          const [lease] = await scopedDb
            .select({
              leaseEpoch: schema.sandboxLeases.leaseEpoch,
              liveness: schema.sandboxLeases.liveness,
              rotationRequestedAt: schema.sandboxLeases.rotationRequestedAt,
            })
            .from(schema.sandboxLeases)
            .where(
              and(
                eq(schema.sandboxLeases.workspaceId, workspaceId),
                eq(schema.sandboxLeases.sandboxGroupId, lifecycleWait.sandboxGroupId),
              ),
            )
            .limit(1);
          if (sandboxLifecycleWaitIsPending(lifecycleWait, lease)) {
            return { kind: "sandbox-lifecycle-wait", ref: lifecycleWait };
          }
        }
        return runnable;
      }
      if (turn.status === "requires_action") {
        const [currentTrigger] = await scopedDb
          .select({ sequence: schema.sessionEvents.sequence })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, workspaceId),
              eq(schema.sessionEvents.sessionId, sessionId),
              eq(schema.sessionEvents.id, turn.triggerEventId),
            ),
          )
          .limit(1);
        if (!currentTrigger) {
          throw new Error(`Turn ${turn.id} points to missing trigger ${turn.triggerEventId}`);
        }
        const [actionResponse] = await scopedDb
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, workspaceId),
              eq(schema.sessionEvents.sessionId, sessionId),
              inArray(schema.sessionEvents.type, [
                "user.approvalDecision",
                "user.humanInputResponse",
              ]),
              gt(schema.sessionEvents.sequence, currentTrigger.sequence),
            ),
          )
          .orderBy(desc(schema.sessionEvents.sequence), desc(schema.sessionEvents.id))
          .limit(1);
        if (actionResponse) {
          return {
            kind: "approval-pending",
            triggerEventId: actionResponse.id,
            ...fence,
          };
        }
        const [expiringHumanInput] = await scopedDb
          .select({
            id: schema.sessionHumanInputRequests.id,
            expiresAt: schema.sessionHumanInputRequests.expiresAt,
          })
          .from(schema.sessionHumanInputRequests)
          .where(
            and(
              eq(schema.sessionHumanInputRequests.workspaceId, workspaceId),
              eq(schema.sessionHumanInputRequests.sessionId, sessionId),
              eq(schema.sessionHumanInputRequests.turnId, turn.id),
              eq(schema.sessionHumanInputRequests.turnGeneration, turn.executionGeneration),
              eq(schema.sessionHumanInputRequests.status, "pending"),
              isNotNull(schema.sessionHumanInputRequests.expiresAt),
            ),
          )
          .orderBy(
            sql`${schema.sessionHumanInputRequests.expiresAt} asc nulls last`,
            asc(schema.sessionHumanInputRequests.id),
          )
          .limit(1);
        const [expiringInteractionIntervention] = await scopedDb
          .select({
            id: schema.interactionInterventions.id,
            expiresAt: schema.interactionInterventions.expiresAt,
          })
          .from(schema.interactionInterventions)
          .where(
            and(
              eq(schema.interactionInterventions.workspaceId, workspaceId),
              eq(schema.interactionInterventions.originatingSessionId, sessionId),
              eq(schema.interactionInterventions.originatingTurnId, turn.id),
              eq(schema.interactionInterventions.status, "open"),
              isNotNull(schema.interactionInterventions.originatingToolCallId),
            ),
          )
          .orderBy(
            asc(schema.interactionInterventions.expiresAt),
            asc(schema.interactionInterventions.id),
          )
          .limit(1);
        // A scheduled run's frozen approval timeout joins the same earliest-
        // deadline choice; the workflow sleeps on it with a durable timer.
        const scheduledDeadline = await scheduledHumanWaitDeadlineInRlsContext(
          scopedDb,
          workspaceId,
          turn,
        );
        const candidates: Array<{
          at: number;
          wait: Extract<SessionWorkPeek, { kind: "approval-wait" }>;
        }> = [];
        if (expiringHumanInput?.expiresAt) {
          candidates.push({
            at: expiringHumanInput.expiresAt.getTime(),
            wait: {
              kind: "approval-wait",
              humanInputRequestId: expiringHumanInput.id,
              expiresAt: expiringHumanInput.expiresAt.toISOString(),
            },
          });
        }
        if (expiringInteractionIntervention) {
          candidates.push({
            at: expiringInteractionIntervention.expiresAt.getTime(),
            wait: {
              kind: "approval-wait",
              interactionInterventionId: expiringInteractionIntervention.id,
              expiresAt: expiringInteractionIntervention.expiresAt.toISOString(),
            },
          });
        }
        if (scheduledDeadline) {
          candidates.push({
            at: Date.parse(scheduledDeadline.expiresAt),
            wait: {
              kind: "approval-wait",
              scheduledRunTimeout: { runId: scheduledDeadline.runId, turnId: turn.id },
              expiresAt: scheduledDeadline.expiresAt,
            },
          });
        }
        // Stable: on a tie, the per-request deadlines keep their precedence.
        candidates.sort((left, right) => left.at - right.at);
        return candidates[0]?.wait ?? { kind: "approval-wait" };
      }
      if (turn.status === "running") {
        if (observerAccountId && turn.activeAttemptId) {
          const [attempt] = await scopedDb
            .select()
            .from(schema.sessionTurnAttempts)
            .where(
              and(
                eq(schema.sessionTurnAttempts.accountId, observerAccountId),
                eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
                eq(schema.sessionTurnAttempts.sessionId, sessionId),
                eq(schema.sessionTurnAttempts.turnId, turn.id),
                eq(schema.sessionTurnAttempts.id, turn.activeAttemptId),
                eq(schema.sessionTurnAttempts.executionGeneration, turn.executionGeneration),
                inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
              ),
            )
            .limit(1);
          if (attempt)
            return {
              kind: "attempt-owned",
              turnId: turn.id,
              attemptId: attempt.id,
              executionGeneration: turn.executionGeneration,
              activityRef: {
                workflowId: attempt.temporalWorkflowId,
                workflowRunId: attempt.temporalWorkflowRunId,
                activityId: attempt.temporalActivityId,
                quiesced: attempt.quiescedAt !== null,
              },
            };
        }
        throw new Error(
          `Session workflow reached admission with turn ${turn.id} still owned by attempt ${turn.activeAttemptId ?? "none"}`,
        );
      }
      throw new Error(`Session ${sessionId} has terminal active turn ${turn.id} (${turn.status})`);
    }

    const [queued] = await scopedDb
      .select({ id: schema.sessionTurns.id })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.status, "queued"),
          inArray(schema.sessionTurns.source, ["user", "api"]),
        ),
      )
      .limit(1);
    if (queued || session.compactRequested) return runnable;
    const waitState = await sessionInputWaitStateTx(scopedDb, workspaceId, sessionId, session);
    const inputWaitPeek =
      session.inputWaitTurnId && session.inputWaitUntil && waitState.disposition !== "none"
        ? ({
            kind: "input-wait",
            disposition: waitState.disposition,
            waitTurnId: session.inputWaitTurnId,
            deadlineAt: session.inputWaitUntil.toISOString(),
          } as const)
        : null;
    const [pendingUpdate] = await scopedDb
      .select({ id: schema.sessionSystemUpdates.id })
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.state, "pending"),
        ),
      )
      .limit(1);
    if (!pendingUpdate) return inputWaitPeek ?? { kind: "idle" };
    if (
      !(await latestFinishedTurnHasFailureCodeTx(
        scopedDb,
        workspaceId,
        sessionId,
        "context_compaction_failed",
      ))
    ) {
      // Immediate machine input wakes a wait and becomes the next turn. Deferred
      // child status notices stay parked until the wait times out, is superseded
      // by newer input, or an immediate input arrives.
      const wakeClasses = await pendingSystemUpdateWakeClassesTx(scopedDb, workspaceId, sessionId);
      if (wakeClasses.immediate || (wakeClasses.command && waitState.disposition === "held")) {
        return runnable;
      }
      return inputWaitPeek ?? (wakeClasses.deferred ? runnable : { kind: "idle" });
    }
    const [pendingAgentSteer] = await scopedDb
      .select({ id: schema.sessionSystemUpdates.id })
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.state, "pending"),
          eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
        ),
      )
      .limit(1);
    return pendingAgentSteer ? runnable : (inputWaitPeek ?? { kind: "idle" });
  };
  return observerAccountId
    ? await withRlsContext(db, { accountId: observerAccountId, workspaceId }, observe)
    : await withWorkspaceRls(db, workspaceId, observe);
}

async function lockChildLifecycleOutboxWriteRowsTx(
  tx: Database,
  workspaceId: string,
  input: { sessionId: string; turnId?: string; attemptId?: string },
) {
  const prefix = await lockSessionEventWriteRows(tx, {
    workspaceId,
    controlLock: "share",
    sessionIds: [],
  });
  const [preview] = await tx
    .select({
      id: schema.sessions.id,
      parentSessionId: schema.sessions.parentSessionId,
    })
    .from(schema.sessions)
    .where(
      and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, input.sessionId)),
    )
    .limit(1);
  if (!preview) throw new Error(`Session not found: ${input.sessionId}`);

  const sessionLocks = await lockSessionEventWriteRows(tx, {
    workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: [input.sessionId, ...(preview.parentSessionId ? [preview.parentSessionId] : [])],
  });
  const session = sessionLocks.sessions.find((row) => row.id === input.sessionId);
  if (!session) throw new Error(`Session not found: ${input.sessionId}`);
  if (session.parentSessionId !== preview.parentSessionId) {
    throw new SessionControlInvariantError(
      `Session ${input.sessionId} parent changed while establishing lifecycle locks`,
    );
  }
  if (
    session.parentSessionId &&
    !sessionLocks.sessions.some((row) => row.id === session.parentSessionId)
  ) {
    throw new SessionControlInvariantError(
      `Parent session ${session.parentSessionId} was not locked with child ${input.sessionId}`,
    );
  }

  let turnId = input.turnId ?? null;
  if (!turnId && input.attemptId) {
    const [attemptPreview] = await tx
      .select({ turnId: schema.sessionTurnAttempts.turnId })
      .from(schema.sessionTurnAttempts)
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
          eq(schema.sessionTurnAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    turnId = attemptPreview?.turnId ?? null;
  }
  const exactLocks = await lockSessionEventWriteRows(tx, {
    workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    turnIds: turnId ? [turnId] : [],
    attemptIds: turnId && input.attemptId ? [input.attemptId] : [],
  });
  return {
    control: prefix.control,
    workspace: prefix.workspace,
    sessions: sessionLocks.sessions,
    turns: exactLocks.turns,
    attempts: exactLocks.attempts,
    session,
  };
}

const TURN_DISPATCH_ATTEMPT_METADATA_KEY = "dispatchAttempt";

const TURN_DISPATCH_GENERATION_METADATA_KEY = "dispatchGeneration";

type TurnDispatchAttempt = {
  id: string;
  generation: number;
  triggerEventId: string;
  pendingUpdateBoundarySequence?: number;
};

type TurnDispatchMetadata =
  | { kind: "absent"; generation: 0; attempt: null }
  | { kind: "valid"; generation: number; attempt: TurnDispatchAttempt | null }
  | { kind: "malformed"; reason: string };

function readTurnDispatchMetadata(metadata: unknown): TurnDispatchMetadata {
  if (metadata === null || metadata === undefined) {
    return { kind: "absent", generation: 0, attempt: null };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { kind: "malformed", reason: "turn metadata is not an object" };
  }
  const record = metadata as Record<string, unknown>;
  const hasAttempt = Object.prototype.hasOwnProperty.call(
    record,
    TURN_DISPATCH_ATTEMPT_METADATA_KEY,
  );
  const hasGeneration = Object.prototype.hasOwnProperty.call(
    record,
    TURN_DISPATCH_GENERATION_METADATA_KEY,
  );
  if (!hasAttempt && !hasGeneration) {
    return { kind: "absent", generation: 0, attempt: null };
  }

  const rawGeneration = record[TURN_DISPATCH_GENERATION_METADATA_KEY];
  if (
    hasGeneration &&
    (typeof rawGeneration !== "number" || !Number.isSafeInteger(rawGeneration) || rawGeneration < 0)
  ) {
    return {
      kind: "malformed",
      reason: "dispatchGeneration is not a safe non-negative integer",
    };
  }
  const generation = hasGeneration ? (rawGeneration as number) : null;

  if (!hasAttempt) {
    return {
      kind: "valid",
      generation: generation ?? 0,
      attempt: null,
    };
  }
  const value = record[TURN_DISPATCH_ATTEMPT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", reason: "dispatchAttempt is not an object" };
  }
  const attempt = value as Record<string, unknown>;
  const pendingUpdateBoundarySequence = attempt.pendingUpdateBoundarySequence;
  if (
    typeof attempt.id !== "string" ||
    attempt.id.length === 0 ||
    typeof attempt.generation !== "number" ||
    !Number.isSafeInteger(attempt.generation) ||
    attempt.generation < 1 ||
    typeof attempt.triggerEventId !== "string" ||
    attempt.triggerEventId.length === 0 ||
    (pendingUpdateBoundarySequence !== undefined &&
      (typeof pendingUpdateBoundarySequence !== "number" ||
        !Number.isSafeInteger(pendingUpdateBoundarySequence) ||
        pendingUpdateBoundarySequence < 0))
  ) {
    return {
      kind: "malformed",
      reason: "dispatchAttempt has an invalid shape",
    };
  }
  if (generation === null || generation !== attempt.generation) {
    return {
      kind: "malformed",
      reason: "dispatchGeneration does not match dispatchAttempt",
    };
  }
  return {
    kind: "valid",
    generation: attempt.generation,
    attempt: {
      id: attempt.id,
      generation: attempt.generation,
      triggerEventId: attempt.triggerEventId,
      ...(pendingUpdateBoundarySequence === undefined ? {} : { pendingUpdateBoundarySequence }),
    },
  };
}

function metadataWithoutTurnDispatchAttempt(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[TURN_DISPATCH_ATTEMPT_METADATA_KEY];
  return next;
}

const SANDBOX_LIFECYCLE_WAIT_METADATA_KEY = "sandboxLifecycleWait";

const SANDBOX_SETUP_OUTCOME_UNKNOWN_METADATA_KEY = "sandboxSetupOutcomeUnknown";

const SANDBOX_SETUP_RECOVERY_EXHAUSTED_METADATA_KEY = "sandboxSetupRecoveryExhausted";

function sandboxSetupRecoveryExhaustedFromTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SandboxSetupRecoveryExhausted | null {
  const value = metadata?.[SANDBOX_SETUP_RECOVERY_EXHAUSTED_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Partial<SandboxSetupRecoveryExhausted>;
  if (
    marker.version !== 1 ||
    typeof marker.turnId !== "string" ||
    marker.turnId.length === 0 ||
    typeof marker.attemptId !== "string" ||
    marker.attemptId.length === 0 ||
    marker.reason !== "sandbox_command_start_recovery_exhausted" ||
    marker.setupOutcome !== "not_started" ||
    marker.providerRecoveryCount !== SANDBOX_SETUP_RECOVERY_LIMIT
  ) {
    return null;
  }
  return marker as SandboxSetupRecoveryExhausted;
}

function sandboxSetupOutcomeUnknownFromTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SandboxSetupOutcomeUnknown | null {
  const value = metadata?.[SANDBOX_SETUP_OUTCOME_UNKNOWN_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Partial<SandboxSetupOutcomeUnknown>;
  if (
    marker.version !== 1 ||
    typeof marker.turnId !== "string" ||
    marker.turnId.length === 0 ||
    typeof marker.attemptId !== "string" ||
    marker.attemptId.length === 0 ||
    marker.reason !== "sandbox_command_start_outcome_unknown"
  ) {
    return null;
  }
  return marker as SandboxSetupOutcomeUnknown;
}

function sandboxLifecycleWaitFromTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SandboxLifecycleWait | null {
  const value = metadata?.[SANDBOX_LIFECYCLE_WAIT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wait = value as Partial<SandboxLifecycleWait>;
  if (
    wait.version !== 1 ||
    typeof wait.sandboxGroupId !== "string" ||
    wait.sandboxGroupId.length === 0 ||
    !Number.isSafeInteger(wait.leaseEpoch) ||
    (wait.leaseEpoch ?? -1) < 0 ||
    wait.reason !== "rotation_in_progress"
  ) {
    return null;
  }
  return wait as SandboxLifecycleWait;
}

function sandboxLifecycleWaitIsPending(
  wait: SandboxLifecycleWait,
  lease:
    | {
        leaseEpoch: number;
        liveness: SandboxLeaseLiveness;
        rotationRequestedAt: Date | null;
      }
    | undefined,
): boolean {
  return Boolean(
    lease &&
    Number(lease.leaseEpoch) === wait.leaseEpoch &&
    lease.liveness !== "cold" &&
    lease.rotationRequestedAt !== null,
  );
}

function sessionEventPayloadRecord(
  payload: unknown,
  payloadCodecVersion: number | null,
): Record<string, unknown> {
  const logicalPayload = fromPostgresLosslessJson(payload, payloadCodecVersion);
  return logicalPayload && typeof logicalPayload === "object" && !Array.isArray(logicalPayload)
    ? (logicalPayload as Record<string, unknown>)
    : {};
}

export async function settleCodexCredentialLeaseLoss(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    holderId: string;
    generation: number;
    expectedRedispatches: number;
    checkpointDurable: boolean;
    recoveryPayload: Record<string, unknown>;
    failedPayload: Record<string, unknown>;
  },
): Promise<SettleCodexCredentialLeaseLossResult> {
  if (!Number.isInteger(input.expectedRedispatches) || input.expectedRedispatches < 0) {
    throw new Error("Codex lease-loss redispatch fence must be a non-negative integer");
  }
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const locks = await lockSessionEventWriteRows(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          controlLock: "share",
          sessionIds: [input.sessionId],
          turnIds: [input.turnId],
          attemptIds: [input.attemptId],
        });
        const session = locks.sessions[0];
        const turn = locks.turns[0];
        const attempt = locks.attempts[0];
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { workspaceControl: locks.control ?? undefined },
        );
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        if (
          !locks.workspace ||
          !session ||
          !turn ||
          !attempt ||
          session.accountId !== input.accountId ||
          turn.accountId !== input.accountId ||
          turn.sessionId !== input.sessionId ||
          attempt.accountId !== input.accountId ||
          attempt.sessionId !== input.sessionId ||
          attempt.turnId !== input.turnId ||
          attempt.executionGeneration !== turn.executionGeneration ||
          effectiveControl.state !== "active" ||
          session.activeTurnId !== input.turnId ||
          !["running", "requires_action"].includes(turn.status) ||
          turn.activeAttemptId !== input.attemptId ||
          currentRedispatches !== input.expectedRedispatches
        ) {
          return { action: "stale", events: [] } as const;
        }

        const leaseRows = await tx.execute(
          sql<{ holder_id: string; generation: number }>`
            select holder_id, generation from codex_credential_leases
            where account_id = ${input.accountId}
              and workspace_id = ${input.workspaceId}
              and turn_id = ${input.turnId}
            for update
          `,
        );
        const lease = leaseRows[0];
        if (
          lease &&
          (lease.holder_id !== input.holderId || Number(lease.generation) !== input.generation)
        ) {
          return { action: "stale", events: [] } as const;
        }

        const now = new Date();
        await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: input.checkpointDurable ? "lease_lost_recoverable" : "failed",
          closedAt: now,
        });
        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "codex_credential_lease_loss",
            sequence,
            now,
            preserveInterruptionRows: input.checkpointDurable,
          },
        );
        sequence = closedTools.sequence;
        const inserted = input.checkpointDurable
          ? await tx
              .insert(schema.sessionEvents)
              .values(
                withLosslessContentWriteVersion(
                  [
                    {
                      accountId: input.accountId,
                      workspaceId: input.workspaceId,
                      sessionId: input.sessionId,
                      sequence: ++sequence,
                      type: "turn.recovery.requested",
                      payload: input.recoveryPayload,
                      turnId: input.turnId,
                      turnGeneration: turn.executionGeneration,
                      turnAttemptId: input.attemptId,
                      turnAssociation: "current",
                      occurredAt: now,
                    },
                    {
                      accountId: input.accountId,
                      workspaceId: input.workspaceId,
                      sessionId: input.sessionId,
                      sequence: ++sequence,
                      type: "session.status.changed",
                      payload: { status: "recovering" },
                      turnId: input.turnId,
                      turnGeneration: turn.executionGeneration,
                      turnAttemptId: input.attemptId,
                      turnAssociation: "current",
                      occurredAt: now,
                    },
                  ],
                  "payload",
                  "payloadCodecVersion",
                ),
              )
              .returning()
          : await tx
              .insert(schema.sessionEvents)
              .values(
                withLosslessContentWriteVersion(
                  [
                    {
                      accountId: input.accountId,
                      workspaceId: input.workspaceId,
                      sessionId: input.sessionId,
                      sequence: ++sequence,
                      type: "turn.failed",
                      payload: input.failedPayload,
                      turnId: input.turnId,
                      turnGeneration: turn.executionGeneration,
                      turnAttemptId: input.attemptId,
                      turnAssociation: "current",
                      occurredAt: now,
                    },
                    {
                      accountId: input.accountId,
                      workspaceId: input.workspaceId,
                      sessionId: input.sessionId,
                      sequence: ++sequence,
                      type: "session.status.changed",
                      payload: { status: "failed" },
                      turnId: input.turnId,
                      turnGeneration: turn.executionGeneration,
                      turnAttemptId: input.attemptId,
                      turnAssociation: "current",
                      occurredAt: now,
                    },
                  ],
                  "payload",
                  "payloadCodecVersion",
                ),
              )
              .returning();
        const settlementEvent = inserted[0];
        if (!settlementEvent) {
          throw new Error("Codex lease-loss settlement did not persist its checkpoint event");
        }
        if (!input.checkpointDurable) {
          await projectSessionRealtimeDelegationTerminalInTransaction(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            turnStatus: "failed",
            terminalEvent: {
              id: settlementEvent.id,
              type: "turn.failed",
              payload: sessionEventPayloadRecord(
                settlementEvent.payload,
                settlementEvent.payloadCodecVersion,
              ),
            },
            now,
          });
        }

        await tx
          .update(schema.sessionTurns)
          .set(
            input.checkpointDurable
              ? {
                  status: "recovering",
                  activeAttemptId: null,
                  finishedAt: null,
                  updatedAt: now,
                }
              : {
                  status: "failed",
                  activeAttemptId: null,
                  finishedAt: now,
                  updatedAt: now,
                },
          )
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          );
        await tx
          .update(schema.sessions)
          .set({
            status: input.checkpointDurable ? "recovering" : "failed",
            activeTurnId: input.checkpointDurable ? input.turnId : null,
            lastSequence: sequence,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          );
        await tx.execute(sql`
          delete from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
        `);
        return {
          action: input.checkpointDurable ? "recovering" : "failed",
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

export async function settleCodexCredentialFailover(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    holderId?: string | null;
    generation?: number | null;
    expectedRedispatches: number;
    maxFailovers: number;
    recoveryPayload: Record<string, unknown>;
    failedPayload?: Record<string, unknown>;
  },
): Promise<SettleCodexCredentialFailoverResult> {
  if (!Number.isInteger(input.expectedRedispatches) || input.expectedRedispatches < 0) {
    throw new Error("Codex failover redispatch fence must be a non-negative integer");
  }
  if (!Number.isInteger(input.maxFailovers) || input.maxFailovers < 1) {
    throw new Error("Codex failover bound must be a positive integer");
  }
  if ((input.holderId == null) !== (input.generation == null)) {
    throw new Error("Codex failover lease fence must be fully present or absent");
  }
  return await retrySessionActivityRls(
    db,
    input.workspaceId,
    {
      stage: "session_lifecycle_outbox.settle_codex_credential_failover",
      eventTypes: ["turn.recovery.requested", "turn.failed", "session.status.changed"],
      maxAttempts: 3,
    },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const locks = await lockChildLifecycleOutboxWriteRowsTx(
          tx as unknown as Database,
          input.workspaceId,
          {
            sessionId: input.sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
          },
        );
        const session = locks.session;
        const turn = locks.turns[0];
        const attempt = locks.attempts[0];
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { workspaceControl: locks.control ?? undefined },
        );
        const currentFailovers = Number(turn?.metadata?.codexCredentialFailovers ?? 0);
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        if (
          !locks.workspace ||
          !session ||
          !turn ||
          !attempt ||
          session.accountId !== input.accountId ||
          turn.accountId !== input.accountId ||
          turn.sessionId !== input.sessionId ||
          attempt.accountId !== input.accountId ||
          attempt.sessionId !== input.sessionId ||
          attempt.turnId !== input.turnId ||
          attempt.executionGeneration !== turn.executionGeneration ||
          effectiveControl.state !== "active" ||
          session.activeTurnId !== input.turnId ||
          !["running", "requires_action"].includes(turn.status) ||
          turn.activeAttemptId !== input.attemptId ||
          currentRedispatches !== input.expectedRedispatches
        ) {
          return {
            action: "stale",
            failoverCount: currentFailovers,
            events: [],
          } as const;
        }

        const leaseRows = await tx.execute(
          sql<{ holder_id: string; generation: number }>`
          select holder_id, generation from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
          for update
        `,
        );
        const lease = leaseRows[0];
        if (
          lease &&
          input.holderId != null &&
          input.generation != null &&
          (lease.holder_id !== input.holderId || Number(lease.generation) !== input.generation)
        ) {
          return {
            action: "stale",
            failoverCount: currentFailovers,
            events: [],
          } as const;
        }

        const persistedMaxFailovers = turn.metadata?.codexCredentialFailoverLimit;
        if (
          persistedMaxFailovers !== undefined &&
          (typeof persistedMaxFailovers !== "number" ||
            !Number.isSafeInteger(persistedMaxFailovers) ||
            persistedMaxFailovers < 1)
        ) {
          throw new Error("Persisted Codex failover bound must be a positive safe integer");
        }
        const maxFailovers = persistedMaxFailovers ?? input.maxFailovers;
        const receiptRecorded = turn.metadata?.codexCredentialFailureAccountingVersion === 1;
        const failoverCount = receiptRecorded ? currentFailovers : currentFailovers + 1;
        if (failoverCount > maxFailovers) {
          const now = new Date();
          await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
            id: input.attemptId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            executionGeneration: turn.executionGeneration,
            outcome: "failed",
            closedAt: now,
          });
          await cancelTurnInteractionInterventionsInTransaction(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
          });
          await settleSessionMaintenanceInTransaction(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          });
          let sequence = session.lastSequence;
          const closedTools = await closePendingSessionToolCallsInTransaction(
            tx as unknown as Database,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "turn_failed",
              sequence,
              now,
            },
          );
          sequence = closedTools.sequence;
          const [waitingPrompt] = await tx
            .select({ id: schema.sessionTurns.id })
            .from(schema.sessionTurns)
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, input.workspaceId),
                eq(schema.sessionTurns.sessionId, input.sessionId),
                eq(schema.sessionTurns.status, "queued"),
                inArray(schema.sessionTurns.source, ["user", "api"]),
              ),
            )
            .limit(1);
          const sessionStatus = waitingPrompt ? "queued" : "idle";
          const failurePayload = {
            error:
              "Automatic Codex credential failover stopped after every bounded account attempt was consumed. Send a new message after checking account health or capacity.",
            code: "codex_credential_failover_exhausted",
            retryable: false,
            recovery: "user_message",
            ...(input.failedPayload ?? {}),
            failoverCount,
            maxFailovers,
          };
          const inserted = await tx
            .insert(schema.sessionEvents)
            .values(
              withLosslessContentWriteVersion(
                [
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: ++sequence,
                    type: "turn.failed",
                    payload: failurePayload,
                    turnId: input.turnId,
                    turnGeneration: turn.executionGeneration,
                    turnAttemptId: input.attemptId,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    sequence: ++sequence,
                    type: "session.status.changed",
                    payload: { status: sessionStatus },
                    turnId: input.turnId,
                    turnGeneration: turn.executionGeneration,
                    turnAttemptId: input.attemptId,
                    turnAssociation: "current",
                    occurredAt: now,
                  },
                ],
                "payload",
                "payloadCodecVersion",
              ),
            )
            .returning();
          const terminalEvent = inserted[0];
          if (!terminalEvent) {
            throw new Error("Codex failover exhaustion did not persist its terminal event");
          }
          await projectSessionRealtimeDelegationTerminalInTransaction(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            turnStatus: "failed",
            terminalEvent: {
              id: terminalEvent.id,
              type: "turn.failed",
              payload: sessionEventPayloadRecord(
                terminalEvent.payload,
                terminalEvent.payloadCodecVersion,
              ),
            },
            now,
          });
          await tx
            .update(schema.sessionTurns)
            .set({
              status: "failed",
              activeAttemptId: null,
              metadata: {
                ...turn.metadata,
                codexCredentialFailovers: failoverCount,
                codexCredentialFailoverLimit: maxFailovers,
                codexCredentialFailoverExhausted: true,
              },
              version: turn.version + 1,
              finishedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, input.workspaceId),
                eq(schema.sessionTurns.id, input.turnId),
              ),
            );
          await enqueueFailedChildOutboxForTurnTx(
            tx as unknown as Database,
            input.workspaceId,
            session,
            turn,
          );
          await tx
            .update(schema.sessions)
            .set({
              status: sessionStatus,
              activeTurnId: null,
              lastSequence: sequence,
              queueVersion: session.queueVersion + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessions.workspaceId, input.workspaceId),
                eq(schema.sessions.id, input.sessionId),
              ),
            );
          await tx
            .update(schema.sessionGoals)
            .set({ continuationSuppressedTurnId: input.turnId, updatedAt: now })
            .where(
              and(
                eq(schema.sessionGoals.workspaceId, input.workspaceId),
                eq(schema.sessionGoals.sessionId, input.sessionId),
                eq(schema.sessionGoals.status, "active"),
              ),
            );
          await tx.execute(sql`
            delete from codex_credential_leases
            where account_id = ${input.accountId}
              and workspace_id = ${input.workspaceId}
              and turn_id = ${input.turnId}
              and (
                ${input.holderId ?? null}::text is null
                or (
                  holder_id = ${input.holderId ?? null}
                  and generation = ${input.generation ?? null}
                )
              )
          `);
          return {
            action: "limit_exceeded",
            failoverCount,
            maxFailovers,
            events: [...closedTools.events, ...inserted.map(mapEvent)],
          } as const;
        }
        const now = new Date();
        await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: "lease_lost_recoverable",
          closedAt: now,
        });
        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "codex_credential_failover",
            sequence,
            now,
            preserveInterruptionRows: true,
          },
        );
        sequence = closedTools.sequence;
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values(
            withLosslessContentWriteVersion(
              [
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "turn.recovery.requested",
                  payload: {
                    ...input.recoveryPayload,
                    failoverCount,
                  },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "session.status.changed",
                  payload: { status: "recovering" },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
              ],
              "payload",
              "payloadCodecVersion",
            ),
          )
          .returning();
        if (!inserted[0]) {
          throw new Error("Codex failover did not persist its checkpoint event");
        }

        await tx
          .update(schema.sessionTurns)
          .set({
            status: "recovering",
            activeAttemptId: null,
            metadata: {
              ...turn.metadata,
              codexCredentialFailovers: failoverCount,
              codexCredentialFailoverLimit: maxFailovers,
            },
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          );
        await tx
          .update(schema.sessions)
          .set({
            status: "recovering",
            activeTurnId: input.turnId,
            lastSequence: sequence,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          );
        await tx.execute(sql`
          delete from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
        `);
        return {
          action: "recovering",
          failoverCount,
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

type ChildOutboxSession = Pick<
  typeof schema.sessions.$inferSelect,
  "id" | "accountId" | "parentSessionId" | "parentTurnId"
>;

type ChildLifecycleNoticeInput = {
  [Kind in ChildLifecycleSystemUpdateKind]: {
    kind: Kind;
    payload: Extract<SessionSystemUpdatePayload, { type: Kind }>;
  };
}[ChildLifecycleSystemUpdateKind] & {
  dedupeKey: string;
  classification: SystemUpdateClassification;
  summary: string;
  lineage?: Record<string, unknown>;
};

async function enqueueChildLifecycleNoticeOutboxTx(
  tx: Database,
  workspaceId: string,
  session: ChildOutboxSession,
  input: ChildLifecycleNoticeInput,
): Promise<boolean> {
  if (!session.parentSessionId) return false;
  const authority = await parentOutboxAuthorityTx(tx, workspaceId, {
    ...session,
    parentSessionId: session.parentSessionId,
  });
  // Freeze complete content at notice creation, never at parent claim time.
  // Oversized evidence is omitted, not truncated and then called consumed.
  // Bound index candidates before payload filters, and prefer the newest complete
  // result within the total budget. Explicit reads handle omitted evidence.
  // A terminal result that carries the child's final answer needs no second
  // copy: an untruncated answer is itself the consumption evidence.
  const carriesFinalAnswer =
    input.kind === "child_terminal_result" && input.payload.finalAnswer !== undefined;
  const candidates = carriesFinalAnswer
    ? []
    : await rawRows<{
        sequence: number;
        type: string;
        payload: unknown;
        payloadCodecVersion: number | null;
      }>(
        tx,
        childLifecycleEvidenceCandidatesSql(sql`${workspaceId}::uuid`, sql`${session.id}::uuid`),
      );
  const noticePayload = carriesFinalAnswer
    ? input.payload
    : { ...input.payload, childEventEvidence: boundedChildLifecycleEvidence(candidates) };
  const inserted = await tx
    .insert(schema.sessionSystemUpdateOutbox)
    .values(
      withLosslessContentWriteVersion(
        withLosslessContentWriteVersion(
          {
            accountId: session.accountId,
            workspaceId,
            sourceSessionId: session.id,
            targetSessionId: session.parentSessionId,
            dedupeKey: input.dedupeKey,
            kind: input.kind,
            classification: input.classification,
            sourceId: session.id,
            summary: input.summary,
            payload: noticePayload,
            lineage: { ...authority.lineage, ...(input.lineage ?? {}) },
            personalConnectionDelegations: authority.personalConnectionDelegations,
            mcpAccountBindings: authority.mcpAccountBindings,
            xaiProviderAccountAuthoritySnapshot: authority.xaiProviderAccountAuthoritySnapshot,
            claudeProviderAccountAuthoritySnapshot:
              authority.claudeProviderAccountAuthoritySnapshot,
            subscriptionAuthority: authority.subscriptionAuthority,
          },
          "summary",
          "summaryCodecVersion",
        ),
        "payload",
        "payloadCodecVersion",
      ),
    )
    .onConflictDoNothing({
      target: [
        schema.sessionSystemUpdateOutbox.workspaceId,
        schema.sessionSystemUpdateOutbox.dedupeKey,
      ],
    })
    .returning({ id: schema.sessionSystemUpdateOutbox.id });
  return inserted.length > 0;
}

async function enqueueFailedChildOutboxTx(
  tx: Database,
  workspaceId: string,
  session: ChildOutboxSession,
  input: { turnId: string | null; dedupeKey: string },
): Promise<void> {
  if (!session.parentSessionId) return;
  await enqueueChildLifecycleNoticeOutboxTx(tx, workspaceId, session, {
    dedupeKey: input.dedupeKey,
    kind: "child_terminal_result",
    classification: "failure",
    summary: "Child session failed; inspect the durable child timeline.",
    payload: {
      type: "child_terminal_result",
      childSessionId: session.id,
      status: "failed",
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    ...(input.turnId ? { lineage: { turnId: input.turnId } } : {}),
  });
}

async function enqueueChildWaitingCapacityOutboxTx(
  tx: Database,
  workspaceId: string,
  session: ChildOutboxSession,
  input: {
    turnId: string;
    waiterId: string;
    provider: "codex" | "xai" | "claude";
    nextCheckAt: Date | null;
  },
): Promise<boolean> {
  if (!session.parentSessionId || !childLifecycleNoticesEnabled()) return false;
  const payload = {
    type: "child_waiting_capacity" as const,
    childSessionId: session.id,
    childTurnId: input.turnId,
    provider: input.provider,
    nextCheckAt: input.nextCheckAt?.toISOString() ?? null,
  };
  return await enqueueChildLifecycleNoticeOutboxTx(tx, workspaceId, session, {
    dedupeKey: childWaitingCapacityDedupeKey({
      childSessionId: session.id,
      waiterId: input.waiterId,
    }),
    kind: "child_waiting_capacity",
    classification: "info",
    summary: childWaitingCapacitySummary(session.id, payload),
    payload,
    lineage: { turnId: input.turnId },
  });
}

async function enqueueFailedChildOutboxForTurnTx(
  tx: Database,
  workspaceId: string,
  session: Pick<
    typeof schema.sessions.$inferSelect,
    "id" | "accountId" | "parentSessionId" | "parentTurnId"
  >,
  turn: Pick<typeof schema.sessionTurns.$inferSelect, "id" | "accountId" | "sessionId">,
): Promise<void> {
  if (turn.accountId !== session.accountId || turn.sessionId !== session.id) {
    throw new SessionControlInvariantError(
      `Failed child turn ${turn.id} lost session ${session.id} ownership`,
    );
  }
  await enqueueFailedChildOutboxTx(tx, workspaceId, session, {
    turnId: turn.id,
    dedupeKey: `child-completion:${turn.sessionId}:turn:${turn.id}`,
  });
}

async function withWorkspaceSessionEventActivityRls<T>(
  db: Database,
  workspaceId: string,
  advancesActivity: boolean,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return advancesActivity
    ? await withWorkspaceSessionActivityRls(db, workspaceId, fn)
    : await withWorkspaceRls(db, workspaceId, fn);
}

async function scheduledHumanWaitTargetInRlsContext(
  scopedDb: Database,
  workspaceId: string,
  turn: { id: string; sessionId: string; executionGeneration: number },
): Promise<{ kind: "approval"; approvalId: string } | { kind: "input"; requestId: string } | null> {
  const [runState] = await scopedDb
    .select({
      pendingApprovals: schema.agentRunStates.pendingApprovals,
      pendingApprovalsCodecVersion: schema.agentRunStates.pendingApprovalsCodecVersion,
    })
    .from(schema.agentRunStates)
    .where(
      and(
        eq(schema.agentRunStates.workspaceId, workspaceId),
        eq(schema.agentRunStates.sessionId, turn.sessionId),
        eq(schema.agentRunStates.turnId, turn.id),
      ),
    )
    .orderBy(desc(schema.agentRunStates.stateVersion))
    .limit(1);
  const pendingApprovals = runState
    ? fromPostgresLosslessJson(runState.pendingApprovals, runState.pendingApprovalsCodecVersion)
    : [];
  const approvalId = (Array.isArray(pendingApprovals) ? pendingApprovals : [])
    .map((pending) => approvalIdentifier(pending))
    .find((id): id is string => typeof id === "string" && id.length > 0);
  if (approvalId) return { kind: "approval", approvalId };
  const requests = await scopedDb
    .select({
      id: schema.sessionHumanInputRequests.id,
      questions: schema.sessionHumanInputRequests.questions,
    })
    .from(schema.sessionHumanInputRequests)
    .where(
      and(
        eq(schema.sessionHumanInputRequests.workspaceId, workspaceId),
        eq(schema.sessionHumanInputRequests.sessionId, turn.sessionId),
        eq(schema.sessionHumanInputRequests.turnId, turn.id),
        eq(schema.sessionHumanInputRequests.turnGeneration, turn.executionGeneration),
        eq(schema.sessionHumanInputRequests.status, "pending"),
      ),
    )
    .orderBy(
      asc(schema.sessionHumanInputRequests.createdAt),
      asc(schema.sessionHumanInputRequests.id),
    )
    .limit(16);
  const request = requests.find(
    (candidate) => !candidate.questions.some((question) => question.skillReview != null),
  );
  return request ? { kind: "input", requestId: request.id } : null;
}

async function scheduledHumanWaitDeadlineInRlsContext(
  scopedDb: Database,
  workspaceId: string,
  turn: {
    id: string;
    sessionId: string;
    executionGeneration: number;
    scheduledTaskRunId: string | null;
  },
): Promise<{ runId: string; expiresAt: string } | null> {
  if (!turn.scheduledTaskRunId) return null;
  const [wait] = await scheduledRunHumanWaitsInRlsContext(scopedDb, workspaceId, {
    turnId: turn.id,
  });
  if (!wait?.expiresAt || wait.runId !== turn.scheduledTaskRunId) return null;
  const target = await scheduledHumanWaitTargetInRlsContext(scopedDb, workspaceId, turn);
  return target ? { runId: wait.runId, expiresAt: wait.expiresAt } : null;
}

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  };
}

async function wakeCodexCapacityAfterPlanChange(
  db: Database,
  workspaceId: string,
  acceptedTurnId: string | undefined,
): Promise<void> {
  await withSessionCodexCapacityMutation(
    db,
    {
      workspaceId,
      reason: "codex_plan_changed",
      acceptedTurnId,
      mutationSource: "effective",
    },
    async () => ({ result: undefined, changed: true }),
  );
}

function codexAuthDeps(authority?: CodexAcceptedCredentialAuthority): CodexAuthDeps {
  return {
    loadCredential: (db, settings, workspaceId, credentialId) =>
      loadCodexCredentialForRun(db, settings, workspaceId, credentialId, authority),
    recordRefresh: (db, input) => recordCodexTokenRefresh(db, { ...input, authority }),
    setStatus: (db, workspaceId, status, lastError, target) =>
      setCodexCredentialStatus(db, workspaceId, status, lastError, target, authority),
    refresh: refreshCodexToken,
    encrypt: encryptEnvironmentValue,
    keyBytes: environmentsEncryptionKeyBytes,
    withRefreshLock: withCodexCredentialRefreshLock,
    recordUsage: async (db, workspaceId, credentialId, snapshot) =>
      (
        await recordCodexAccountUsageWithWakeTargets(
          db,
          workspaceId,
          credentialId,
          snapshot,
          authority,
        )
      ).result,
    onPlanExclusionRetired: async (db, workspaceId) => {
      await wakeCodexCapacityAfterPlanChange(db, workspaceId, authority?.turnId);
    },
  };
}

export function buildCodexTokenResolver(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  deps: CodexAuthDeps = codexAuthDeps(),
  authority?: CodexAcceptedLeaseAuthority,
): ReturnType<typeof buildCodexTokenResolverCore> {
  if (authority) {
    deps = {
      ...deps,
      loadCredential: (targetDb, targetSettings, targetWorkspaceId, targetCredentialId) =>
        loadCodexCredentialForRun(
          targetDb,
          targetSettings,
          targetWorkspaceId,
          targetCredentialId,
          authority,
        ),
      recordRefresh: (targetDb, input) =>
        recordCodexTokenRefresh(targetDb, { ...input, authority }),
      setStatus: (targetDb, targetWorkspaceId, status, lastError, target) =>
        setCodexCredentialStatus(targetDb, targetWorkspaceId, status, lastError, target, authority),
      onPlanExclusionRetired: (targetDb, targetWorkspaceId) =>
        wakeCodexCapacityAfterPlanChange(targetDb, targetWorkspaceId, authority.turnId),
    };
  }
  return buildCodexTokenResolverCore(db, settings, workspaceId, credentialId, deps);
}

function codexAppsAuthDeps(): CodexAuthDeps {
  return {
    loadCredential: async (db, settings, workspaceId, credentialId) => {
      const credential = await loadCodexCredentialForRun(
        db,
        settings,
        workspaceId,
        credentialId,
        CODEX_APPS_CREDENTIAL_USE,
      );
      if (!credential) throw new CodexAppsCredentialUnavailable();
      if (credential.status !== "active") {
        // Still the designation, but its sign-in is no longer usable: the
        // remedy is reconnecting this account, not choosing another one.
        throw new CodexReloginRequired("The designated Codex Apps account must be reconnected.");
      }
      return credential;
    },
    refreshKeyScope: "codex_apps",
    recordRefresh: (db, input) =>
      recordCodexTokenRefresh(db, { ...input, authority: CODEX_APPS_REFRESH_OUTCOME }),
    setStatus: (db, workspaceId, status, lastError, target) =>
      setCodexCredentialStatus(
        db,
        workspaceId,
        status,
        lastError,
        target,
        CODEX_APPS_REFRESH_OUTCOME,
      ),
    refresh: refreshCodexToken,
    encrypt: encryptEnvironmentValue,
    keyBytes: environmentsEncryptionKeyBytes,
    withRefreshLock: withCodexCredentialRefreshLock,
    onPlanExclusionRetired: async (db, workspaceId) => {
      await wakeCodexCapacityAfterPlanChange(db, workspaceId, undefined);
    },
  };
}

export function buildCodexAppsTokenResolver(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  options: { refresh?: CodexAuthDeps["refresh"] } = {},
): ReturnType<typeof buildCodexTokenResolverCore> {
  const deps = codexAppsAuthDeps();
  return buildCodexTokenResolverCore(
    db,
    settings,
    workspaceId,
    credentialId,
    options.refresh ? { ...deps, refresh: options.refresh } : deps,
  );
}

export function codexAppsRequestAuth(
  db: Database,
  settings: Settings,
  input: { workspaceId: string; credentialId: string },
): CodexAppsRequestAuth {
  const resolver = buildCodexAppsTokenResolver(db, settings, input.workspaceId, input.credentialId);
  return {
    clientVersion: CODEX_CLIENT_VERSION,
    withAuthorization: async (use) => {
      const token = await resolver.getToken();
      return await withCodexAppsRequestAuthorization(
        db,
        { workspaceId: input.workspaceId, credentialId: input.credentialId },
        async () =>
          await use({ accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId }),
      );
    },
  };
}

export async function fetchCodexUsageForAccount(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  fetchImpl: CodexFetch = fetch,
  acceptedTurnId?: string,
): ReturnType<typeof fetchCodexUsageForAccountCore> {
  return await fetchCodexUsageForAccountCore(
    db,
    settings,
    workspaceId,
    credentialId,
    codexAuthDeps(
      acceptedTurnId ? { turnId: acceptedTurnId, purpose: "capacity_refresh" } : undefined,
    ),
    fetchImpl,
  );
}

export async function recheckCodexCredentialPlan(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  authority: CodexAcceptedLeaseAuthority | { turnId: string; purpose: "capacity_refresh" },
  fetchImpl: CodexFetch = fetch,
): ReturnType<typeof recheckCodexCredentialPlanCore> {
  return await recheckCodexCredentialPlanCore(
    db,
    settings,
    workspaceId,
    credentialId,
    codexAuthDeps(authority),
    fetchImpl,
  );
}

export async function fetchCodexRateLimitResetCreditsForAccount(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  fetchImpl: CodexFetch = fetch,
): ReturnType<typeof fetchCodexRateLimitResetCreditsForAccountCore> {
  return await fetchCodexRateLimitResetCreditsForAccountCore(
    db,
    settings,
    workspaceId,
    credentialId,
    codexAuthDeps(),
    fetchImpl,
  );
}
