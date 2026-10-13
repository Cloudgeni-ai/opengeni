/**
 * Claude's legacy route shapes on the shared subscription core (design
 * docs/design/subscription-core-2026-10-07.md, 5.3 "Claude track", C2b).
 *
 * Dormant: API handlers call into this module only when
 * `readSubscriptionCoreProviderRoute(..., "claude")` is `core`, which needs
 * the Claude cutover receipt (C3); until then the binding is not registered
 * and every shared runtime refuses it. Pools, settings and writers are the
 * provider-neutral ones; this module projects neutral rows into the legacy
 * Claude account shape and encodes an OAuth sign-in or a pasted setup token
 * as the adapter's stored credential. Nothing here reads or writes a legacy
 * Claude table or returns credential material.
 */
import type { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import type { SubscriptionCorePoolAccount } from "./subscription-core/account-projection";
import { withRlsContext, type Database } from "./database";
import { encryptEnvironmentValue } from "./environment-crypto";
import {
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCorePersonalConnectionVersionsInTransaction,
  readSubscriptionCoreWorkspaceView,
  type SubscriptionCoreConnectionRow,
} from "./subscription-core/administration";
import {
  connectSubscriptionCoreConnection,
  type SubscriptionCoreConnectResult,
  type SubscriptionCoreConnectScope,
} from "./subscription-core/connections";
import {
  SUBSCRIPTION_CORE_CLAUDE,
  type SubscriptionCoreClaudeCredential,
} from "./subscription-core-claude-adapter";
import { projectSubscriptionCoreClaudeUsage } from "./subscription-core-claude-usage";

export type SubscriptionCoreClaudeScope = "workspace" | "user" | "organization";

/** A core Claude connection in the legacy account shape, with its usage reading. */
export type ClaudeSubscriptionAccountMetadata = SubscriptionCorePoolAccount;
export type SubscriptionCoreClaudeAccount = SubscriptionCorePoolAccount & {
  usage: ClaudeSubscriptionUsage;
};

function date(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

/**
 * A listed connection's row version: a positive integer, or the listing
 * fails (never a made-up version a reconnect could be fenced on).
 */
function rowVersion(row: SubscriptionCoreConnectionRow): number {
  const version = Number(row.version ?? Number.NaN);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("core Claude connection has no row version");
  return version;
}

/**
 * One core connection in the legacy Claude account shape. `version` is the
 * connection's row version, the one legacy credential version on the core:
 * the listing's `version` and `usage.credentialVersion` alike (the web
 * client treats a difference as a credential change). It moves on connect,
 * reconnect, rename and every status transition (needs_relogin, quarantine,
 * recovery), never on a successful refresh (that moves
 * `refresh_generation` only), and fences a reconnect. The legacy quota
 * columns and selection counters have no core counterpart and no Claude
 * route projects them.
 */
export function projectSubscriptionCoreClaudeAccount(
  row: SubscriptionCoreConnectionRow,
  scope: SubscriptionCoreClaudeScope,
  allocatorEnabled = row.allocator_enabled,
): SubscriptionCoreClaudeAccount {
  const version = rowVersion(row);
  return {
    id: row.id,
    scope,
    providerAccountId: row.provider_account_id,
    allowedModelIds: row.allowed_model_ids,
    label: row.label,
    accountEmail: row.account_email,
    planType: row.plan_type,
    status: row.status as ClaudeSubscriptionAccountMetadata["status"],
    allocatorEnabled,
    version,
    allocatorVersion: Number(row.allocator_version),
    allocatorUpdatedAt: date(row.updated_at),
    expiresAt: date(row.expires_at),
    lastRefreshAt: date(row.last_refresh_at),
    lastError: row.last_error,
    quotaUsedPercent: null,
    quotaResetAt: null,
    quotaCheckedAt: null,
    exhaustedUntil: null,
    selectionCount: 0,
    lastSelectedAt: null,
    connectedBySubjectId: row.connected_by_subject_id,
    // C2a's projection of the quota row, at the listed credential version.
    usage: { ...projectSubscriptionCoreClaudeUsage(row), credentialVersion: version },
  };
}

export type SubscriptionCoreClaudePoolProjection = {
  /** As for SuperGrok: `user` in the viewer's Personal workspace with personal rows, else the shared source. */
  source: SubscriptionCoreClaudeScope;
  accounts: SubscriptionCoreClaudeAccount[];
  activeCredentialId: string | null;
  rotationEnabled: boolean;
};

/**
 * A workspace's Claude pool for one viewer in the legacy shapes. Shared
 * connections carry the pool they serve this workspace from; personal ones
 * (listed only to their owner, only in the owner's Personal workspace) are
 * `user`, with their version read through the owner reader. Both reads share
 * one snapshot (repeatable read), so a concurrent disconnect cannot leave a
 * listed personal row without its version; a mismatch is a defect and fails.
 */
export async function getSubscriptionCoreClaudeWorkspaceProjection(
  db: Database,
  input: { accountId: string; workspaceId: string; viewerSubjectId: string },
): Promise<SubscriptionCoreClaudePoolProjection> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const view = await readSubscriptionCoreWorkspaceView(tx, SUBSCRIPTION_CORE_CLAUDE, input);
      const versions =
        view.personal.length > 0
          ? await readSubscriptionCorePersonalConnectionVersionsInTransaction(
              tx,
              SUBSCRIPTION_CORE_CLAUDE,
              { ...input, subjectId: input.viewerSubjectId },
            )
          : new Map<string, number>();
      return {
        source:
          view.personal.length > 0
            ? "user"
            : view.pool.source.effectiveSource === "organization" &&
                view.pool.source.organizationAvailable
              ? "organization"
              : "workspace",
        accounts: [
          ...view.pool.connections.map((entry) =>
            projectSubscriptionCoreClaudeAccount(
              entry.row,
              entry.source,
              entry.row.allocator_enabled && entry.poolAllocatorEnabled,
            ),
          ),
          ...view.personal.map((row) => {
            // No version from the owner reader fails the listing (rowVersion).
            const version = versions.get(row.id);
            return projectSubscriptionCoreClaudeAccount(
              version === undefined ? row : { ...row, version },
              "user",
            );
          }),
        ],
        activeCredentialId: view.primaryConnectionId,
        rotationEnabled: view.pool.rotationMode === "spread",
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/** The organization's own Claude accounts and rotation; empty for a non-administrator. */
export async function getSubscriptionCoreClaudeOrganizationProjection(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<SubscriptionCoreClaudePoolProjection> {
  const pool = await readSubscriptionCoreOrganizationPool(db, SUBSCRIPTION_CORE_CLAUDE, input);
  return {
    source: "organization",
    accounts: (pool?.rows ?? []).map((row) =>
      projectSubscriptionCoreClaudeAccount(row, "organization"),
    ),
    activeCredentialId: pool?.primaryConnectionId ?? null,
    rotationEnabled: pool ? pool.rotationMode === "spread" : false,
  };
}

/** An HMAC provider account id: a credential proves no Claude account (`setup:`/`oauth:`). */
export function isSubscriptionCoreClaudeUnverifiedAccountId(id: string | null): boolean {
  return id !== null && /^(setup|oauth):/.test(id);
}

/**
 * The identity a Claude reconnect writes, or null when the sign-in may not
 * replace the target (design 5.3, C2b, "Reconnect"). A core connection's
 * upstream identity never changes:
 * - a credential that proves an account (an OAuth account uuid) reconnects
 *   only that account;
 * - one that proves none (a setup token, or an OAuth sign-in without an
 *   account uuid) keeps the target's `setup:`/`oauth:` id, and only for such
 *   a target, never one whose account was proven.
 */
export function subscriptionCoreClaudeReconnectIdentity(
  targetProviderAccountId: string | null,
  signedIn: { providerAccountId: string; verified: boolean },
): string | null {
  if (signedIn.verified) {
    return targetProviderAccountId === signedIn.providerAccountId
      ? signedIn.providerAccountId
      : null;
  }
  return isSubscriptionCoreClaudeUnverifiedAccountId(targetProviderAccountId)
    ? targetProviderAccountId
    : null;
}

export type SubscriptionCoreClaudeConnectResult =
  | SubscriptionCoreConnectResult
  /**
   * A reconnect whose credential may not replace the target:
   * `setup_token_over_sign_in` (a setup token for an account a sign-in
   * proved), `sign_in_over_unverified` (a proven sign-in for an account
   * whose id is unverified: a setup token's, or an earlier sign-in's without
   * an account uuid), else `different_account`.
   */
  | {
      kind: "refused";
      reason: "different_account" | "setup_token_over_sign_in" | "sign_in_over_unverified";
    };

function reconnectRefusal(
  targetProviderAccountId: string | null,
  signedIn: { providerAccountId: string; setupToken: boolean },
): Extract<SubscriptionCoreClaudeConnectResult, { kind: "refused" }>["reason"] {
  const targetProven = !isSubscriptionCoreClaudeUnverifiedAccountId(targetProviderAccountId);
  if (signedIn.setupToken && targetProven) return "setup_token_over_sign_in";
  if (
    !isSubscriptionCoreClaudeUnverifiedAccountId(signedIn.providerAccountId) &&
    isSubscriptionCoreClaudeUnverifiedAccountId(targetProviderAccountId)
  )
    return "sign_in_over_unverified";
  return "different_account";
}

/**
 * Connect (or reconnect) one Claude account from an OAuth sign-in or a
 * pasted setup token through the neutral connect writer. The stored
 * credential is the legacy secret object (the adapter's codec), its format
 * the adapter's (`claude_oauth_v1` with OAuth, else
 * `claude_setup_token_v1`), and the adapter-owned provider state records
 * the granted OAuth scopes (`[]` for a setup token). The provider account
 * id is the legacy one (the account uuid, else the `oauth:`/`setup:` HMAC
 * id); the Claude account is the person's own, so it is also the provider
 * subject. A `reconnect` replaces exactly that connection at that version
 * and keeps its identity. The caller delivers `wake` after commit.
 */
export async function connectSubscriptionCoreClaudeConnection(
  db: Database,
  input: SubscriptionCoreConnectScope & {
    encryptionKey: Uint8Array;
    credential: SubscriptionCoreClaudeCredential;
    /** The legacy provider account id this sign-in computes. */
    providerAccountId: string;
    accountEmail: string | null;
    planType: string | null;
    label: string | null;
    connectedBySubjectId: string | null;
    /** The target of a reconnect and its listed provider account id. */
    reconnectTarget?: {
      connectionId: string;
      expectedVersion: number;
      providerAccountId: string | null;
    };
  },
): Promise<SubscriptionCoreClaudeConnectResult> {
  const { adapter } = SUBSCRIPTION_CORE_CLAUDE;
  const target = input.reconnectTarget;
  const providerAccountId = target
    ? subscriptionCoreClaudeReconnectIdentity(target.providerAccountId, {
        providerAccountId: input.providerAccountId,
        verified: !isSubscriptionCoreClaudeUnverifiedAccountId(input.providerAccountId),
      })
    : input.providerAccountId;
  if (providerAccountId === null)
    return {
      kind: "refused",
      reason: reconnectRefusal(target!.providerAccountId, {
        providerAccountId: input.providerAccountId,
        setupToken: input.credential.oauth === undefined,
      }),
    };
  return await connectSubscriptionCoreConnection(db, SUBSCRIPTION_CORE_CLAUDE, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ...(input.personal ? { personal: true } : {}),
    ...(target
      ? {
          reconnect: { connectionId: target.connectionId, expectedVersion: target.expectedVersion },
        }
      : {}),
    returnVersion: true,
    credentialEncrypted: encryptEnvironmentValue(
      input.encryptionKey,
      adapter.credential.encode(input.credential),
    ),
    credentialFormat: adapter.credential.format(input.credential),
    providerAccountId,
    providerSubjectId: providerAccountId,
    planType: input.planType,
    providerState: { oauthScopes: input.credential.oauth?.scopes ?? [] },
    expiresAt: adapter.credential.expiry(input.credential),
    lastRefreshAt: new Date(),
    accountEmail: input.accountEmail,
    label: input.label,
    connectedBySubjectId: input.connectedBySubjectId,
  });
}
