import type { LegacySubscriptionRetirement } from "./types";

/**
 * Claude (`claude`) decision state retired by M4 C4, after the drained C3
 * cutover (0720) moved it onto the shared subscription core. The six legacy
 * tables (the pool factory's five plus `claude_subscription_account_usage`)
 * stay for forensics, read-only once the receipt exists; their routines stay
 * until the retirement step drops them. Two codec stages stay for as long as
 * their migrations ship, because a fresh install and a one-window upgrade
 * still run them: 0598's (legacy model connections into the Claude pool) and
 * 0720's (the pool into the shared core).
 */
export const LEGACY_CLAUDE_RUNTIME: LegacySubscriptionRetirement = {
  id: "claude",
  name: "Claude (M4 C4)",
  identifiers: [
    // The factory tables and the per-credential usage table.
    "claude_subscription_credentials",
    "claudeSubscriptionCredentials",
    "claude_capacity_waiters",
    "claudeCapacityWaiters",
    "claude_credential_leases",
    "claudeCredentialLeases",
    "claude_rotation_settings",
    "claudeRotationSettings",
    "claude_session_account_pins",
    "claudeSessionAccountPins",
    "claude_subscription_account_usage",
    "claudeSubscriptionAccountUsage",
    // The legacy routines (dropped by the retirement step).
    "resolve_claude_authority_pool",
    "revalidate_claude_subscription_authority",
    "create_claude_subscription_credential",
    "disconnect_claude_subscription_credential",
    "claude_subscription_authority_live",
    "claude_subscription_pool_visible",
    // Connection-based usage, dead since 0598 moved every Claude model
    // connection into the pool and blanked it.
    "claude_usage_snapshot",
    "claudeUsageSnapshot",
    // The legacy turn-local auth recovery state; 0720 converts live values
    // into `subscription_turn_failures` rows.
    "claudeAuthRecovery",
  ],
  patterns: [
    {
      // The synthetic pool subject that owned shared legacy rows. Recognizing
      // it stays (older rows carry it); minting it for Claude does not.
      pattern:
        /subscriptionPoolWorkerSubject\(\s*["'`]claude["'`]\s*\)|["'`]worker:claude-workspace["'`]/g,
      message: "Retired Claude synthetic pool subject",
    },
  ],
  // The deleted legacy producers. `claude-subscription-usage` is not listed:
  // contracts, config and runtime keep modules of that name (the usage
  // contract and request helpers); the deleted db module is caught by its
  // `claudeUsageSnapshot` identifiers.
  deletedModules: [
    /claude-subscription-(?:accounts|account-usage|account-tokens|tokens)(?:\.[cm]?[jt]s)?$/,
  ],
  exceptions: {
    "packages/db/src/schema.ts": {
      declarations: [
        "claudePoolTables",
        "claudeSubscriptionCredentials",
        "claudeRotationSettings",
        "claudeCredentialLeases",
        "claudeSessionAccountPins",
        "claudeCapacityWaiters",
        "claudeSubscriptionAccountUsage",
        "connections",
        "organizationModelProviderConnections",
      ],
      reason:
        "Historical schema and foreign keys remain; no table or column drops (the blanked claude_usage_snapshot columns included).",
    },
    "packages/db/src/runtime-posture.ts": {
      declarations: [
        "FORCE_RLS_TABLES",
        "SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES",
        "CLAUDE_SNAPSHOT_VALIDATOR_ROUTINE",
        "CLAUDE_AUTHORITY_ROUTINES",
        "CLAUDE_SUBSCRIPTION_CAPABILITY_ROUTINES",
      ],
      reason:
        "Declarative deployed-schema RLS and privilege inventory, not provider decision queries.",
    },
    "packages/db/src/claude-subscription-pool-migration.ts": {
      declarations: ["LegacyCredential", "migrateClaudeSubscriptionPoolCredentials"],
      reason:
        "0598 codec stage: moves legacy Claude model connections into the pool and blanks them; runs only inside its migration.",
    },
    "packages/db/src/claude-subscription-core-cutover.ts": {
      declarations: ["migrateClaudeSubscriptionCoreCredentials", "moveClaudeCredentials"],
      reason:
        "0720 codec stage: decodes the legacy rows before the atomic scrub and receipt; never a request fallback.",
    },
  },
};
