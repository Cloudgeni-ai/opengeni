import type { LegacySubscriptionRetirement } from "./types";

/**
 * SuperGrok (`xai`) decision state retired by M4 X4, after the drained X3
 * cutover (0719) moved it onto the shared subscription core. The five legacy
 * tables stay for forensics (read-only once the receipt exists), their
 * routines stay until the retirement step drops them, and the codec stage
 * with the legacy secret decoder it calls stays for as long as 0719 ships:
 * a fresh install and a one-window upgrade still run it.
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
        "0719 codec stage: decodes the legacy rows before the atomic scrub and receipt; never a request fallback.",
    },
  },
};
