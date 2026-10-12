import type { LegacySubscriptionRetirement } from "./types";

/**
 * SuperGrok (`xai`) decision state retired by M4 X4, after the drained X3
 * cutover (0721) moved it onto the shared subscription core. The five legacy
 * tables stay for forensics (read-only once the receipt exists), their
 * routines stay until the retirement step drops them, and the codec stage
 * with the legacy secret decoder it calls stays for as long as 0721 ships:
 * a fresh install and a one-window upgrade still run it.
 *
 * X4 deleted the v1 SuperGrok repository instance and every reader and
 * writer built on it (connect, disconnect, rotation, pins, leases, waiters,
 * quota, the legacy video token envelope, the M1 shadow). Their names are
 * listed below so a runtime cannot quietly reintroduce them; the shared
 * factory stays provider-parameterized for Claude until its own retirement.
 */
export const LEGACY_XAI_RUNTIME: LegacySubscriptionRetirement = {
  id: "xai",
  name: "SuperGrok (M4 X4)",
  identifiers: [
    // The factory tables.
    "xai_subscription_credentials",
    "xaiSubscriptionCredentials",
    "xai_capacity_waiters",
    "xaiCapacityWaiters",
    "xai_credential_leases",
    "xaiCredentialLeases",
    "xai_rotation_settings",
    "xaiRotationSettings",
    "xai_session_account_pins",
    "xaiSessionAccountPins",
    // The legacy routines (dropped by the retirement step).
    "resolve_xai_authority_pool",
    "revalidate_xai_subscription_authority",
    "create_xai_subscription_credential",
    "disconnect_xai_subscription_credential",
    "xai_subscription_authority_live",
    "xai_subscription_pool_visible",
    // The deleted v1 repository instance and its readers and writers.
    "xaiSubscriptionRepository",
    "xaiCapacityRepository",
    "xaiCredentialMetadataColumns",
    "xaiCredentialShardIndex",
    "xaiCredentialWorkspacePredicate",
    "xaiRotationWorkspacePredicate",
    "createXaiSubscriptionCredential",
    "upsertXaiSubscriptionCredential",
    "disconnectXaiSubscriptionCredential",
    "disconnectXaiSubscriptionCredentialAndRepick",
    "renameXaiSubscriptionAccount",
    "updateXaiSubscriptionAccountSettings",
    "updateXaiAllocatorEligibility",
    "updateXaiQuotaMetadata",
    "refreshXaiSubscriptionCredentialSerialized",
    "listXaiSubscriptionAccountsMetadata",
    "getXaiSubscriptionAccountMetadata",
    "getXaiSubscriptionAccountAuthoritySnapshot",
    "ensureXaiRotationSettings",
    "getXaiRotationSettings",
    "updateXaiRotationSettings",
    "setActiveXaiCredential",
    "setInitialActiveXaiCredential",
    "getXaiSessionAccountPin",
    "setXaiSessionAccountPin",
    "recordXaiSessionLastAccount",
    "selectXaiCredentialForUse",
    "selectXaiTurnCapacity",
    "materializeXaiCredentialForRun",
    "acquireXaiCredentialLease",
    "releaseXaiCredentialLease",
    "heartbeatXaiCredentialLeaseUntil",
    "resolveXaiPoolMembershipInTransaction",
    "resolveXaiProviderAccountAuthoritySnapshotForAcceptance",
    "resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction",
    "resolveXaiSharedPoolAuthoritySnapshotInTransaction",
    "XaiAccountAuthorityScope",
    "XaiAllocatorUpdateResult",
    "XaiAuthorityPoolInactiveError",
    "XaiCredentialForRun",
    "XaiCredentialLeaseQuarantine",
    "XaiCredentialLeaseResult",
    "XaiCredentialSecretV1",
    "XaiCredentialStatus",
    "XaiSerializedCredentialRefreshResult",
    // The organization surface and the legacy waiters.
    "listOrganizationXaiSubscriptions",
    "upsertOrganizationXaiSubscription",
    "updateOrganizationXaiSubscription",
    "updateOrganizationXaiRotation",
    "withOrganizationXaiCapacityMutation",
    "armXaiCapacityWait",
    "reconcileXaiCapacityWait",
    "getXaiCapacityWaitForSession",
    "getXaiCapacityWaitForSessionInTransaction",
    "supersedeXaiCapacityWaitInTransaction",
    "wakeXaiCapacityWaiters",
    "mapXaiCapacityWaiter",
    "resolveXaiWaiterSubject",
    "ArmXaiCapacityWaitResult",
    "ReconcileXaiCapacityWaitResult",
    "XaiCapacityWait",
    // The legacy readiness, quota, authorization and video envelope.
    "workspaceXaiSubscriptionActive",
    "workspaceXaiSubscriptionActiveForAuthority",
    "xaiCatalogReadinessAuthority",
    "refreshExhaustedXaiQuota",
    "classifyXaiCredentialFailure",
    "buildXaiSubscriptionAuthorization",
    "buildXaiTurnRequestAuthorization",
    "encryptVideoGenerationXaiCredential",
    "xaiVideoGenerationCredentialLease",
    "XaiTurnRequestAuthorization",
    "XaiSubscriptionAuthorization",
    "executeXaiSubscriptionImageGeneration",
    "xaiRotationEnabled",
    "xaiCredentialQuarantined",
    "xaiSubscriptionMetadataFromRow",
  ],
  patterns: [
    {
      // The synthetic pool subject that owned shared legacy rows. Recognizing
      // it stays (older rows carry it); minting it for SuperGrok does not.
      pattern:
        /subscriptionPoolWorkerSubject\(\s*["'`]xai["'`]\s*\)|["'`]worker:xai-workspace["'`]/g,
      message: "Retired SuperGrok synthetic pool subject",
    },
  ],
  // Deleted producers: the v1 repository module, the organization surface,
  // the legacy waiter, quota and API authorization modules. Resolved from the
  // importing file, so the live `@opengeni/xai-subscription` package, the
  // transcription provider (`providers/xai-subscription`) and the core
  // modules (`xai-subscription-core*`, `subscription-core-xai*`) stay
  // importable.
  deletedPaths: [
    "packages/db/src/xai-subscription",
    "packages/db/src/organization-xai-subscriptions",
    "apps/api/src/xai-subscription-auth",
    "apps/worker/src/activities/xai-quota",
    "apps/worker/src/activities/agent-turn/xai-capacity",
  ],
  testFixtures: /legacy-xai/,
  exceptions: {
    "packages/db/src/schema.ts": {
      declarations: [
        "xaiSubscriptionCredentials",
        "xaiRotationSettings",
        "xaiCredentialLeases",
        "xaiSessionAccountPins",
        "xaiCapacityWaiters",
      ],
      reason: "Historical schema and foreign keys remain; no table or column drops.",
    },
    "packages/db/src/runtime-posture.ts": {
      declarations: [
        "FORCE_RLS_TABLES",
        "SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES",
        // Routine signatures and tables of the deployed grant contract; the
        // retirement step removes them with the routines it drops.
        "XAI_CREATE_CREDENTIAL_ROUTINE",
        "XAI_DISCONNECT_CREDENTIAL_ROUTINE",
        "XAI_AUTHORITY_LIVE_ROUTINE",
        "XAI_POOL_VISIBLE_ROUTINE",
        "XAI_RESOLVE_POOL_ROUTINE",
        "XAI_REVALIDATE_CREDENTIAL_ROUTINE",
        "XAI_AUTHORITY_TABLES",
      ],
      reason:
        "Declarative deployed-schema RLS and privilege inventory, not provider decision queries.",
    },
    "packages/db/src/xai-subscription-core-cutover.ts": {
      declarations: [
        "migrateXaiSubscriptionCoreCredentials",
        "moveXaiCredentials",
        "moveXaiCredentialRows",
      ],
      reason:
        "0721 codec stage: decodes the legacy rows before the atomic scrub and receipt; never a request fallback.",
    },
  },
};
