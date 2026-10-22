import type { LegacySubscriptionRetirement } from "./types";

/**
 * Decision state retired by M3 PR4. The reset-redemption ledger is NOT here:
 * it remains the live, generation-fenced core claim/adopt/send/recovery
 * ledger. Public Codex types, aliases and historical event decoders are also
 * retained. Only the codec-aware 0689 migration may read or decode the
 * retired credentials.
 */
export const LEGACY_CODEX_RUNTIME: LegacySubscriptionRetirement = {
  id: "codex",
  name: "Codex (M3 PR4)",
  identifiers: [
    "codex_subscription_credentials",
    "codexSubscriptionCredentials",
    "codex_capacity_waiters",
    "codexCapacityWaiters",
    "codex_credential_leases",
    "codexCredentialLeases",
    "codex_rotation_settings",
    "codexRotationSettings",
    "organization_codex_rotation_settings",
    "organizationCodexRotationSettings",
    "codex_apps_settings",
    "codexAppsSettings",
    "workspace_codex_subscription_preferences",
    "workspaceCodexSubscriptionPreferences",
    "codex_turn_source_bindings",
    "codexTurnSourceBindings",
    "resolve_workspace_codex_subscription_source",
    "capture_legacy_codex_turn_sources",
  ],
  deletedModules: [/codex-(?:rotation|fleet-shadow)(?:\.[cm]?[jt]s)?$/],
  testFixtures: /(?:legacy-codex(?:-[a-z-]+)?|legacy-subscription-world)/,
  exceptions: {
    "packages/db/src/schema.ts": {
      declarations: [
        "codexSubscriptionCredentials",
        "workspaceCodexSubscriptionPreferences",
        "organizationCodexRotationSettings",
        "codexAppsSettings",
        "codexRotationSettings",
        "codexCredentialLeases",
        "codexCapacityWaiters",
        "codexResetRedemptionAttempts",
        "sessions",
      ],
      reason: "Historical schema/FK definitions remain; no table or column drops.",
    },
    "packages/db/src/runtime-posture.ts": {
      declarations: ["FORCE_RLS_TABLES", "RUNTIME_FULL_DML_TABLES", "RUNTIME_READ_ONLY_TABLES"],
      literals: [
        "resolve_workspace_codex_subscription_source(uuid, uuid)",
        "capture_legacy_codex_turn_sources(uuid, uuid)",
      ],
      reason: "Declarative deployed-schema RLS/privilege inventory, not provider decision queries.",
    },
    "packages/db/src/provision-roles.ts": {
      declarations: [],
      literals: [
        "resolve_workspace_codex_subscription_source(uuid,uuid)",
        "capture_legacy_codex_turn_sources(uuid,uuid)",
      ],
      reason:
        "Exact routine-signature inventory for deployed role grants, never an executable decision read.",
    },
    "packages/db/src/codex-subscription-core-cutover.ts": {
      declarations: ["moveCodexCredentials"],
      reason:
        "0689 migration codec stage decodes legacy rows before its atomic scrub/receipt; never a request fallback.",
    },
  },
};
