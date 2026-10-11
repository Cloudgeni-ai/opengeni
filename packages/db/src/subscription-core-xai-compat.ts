/**
 * SuperGrok's legacy route shapes on the shared subscription core (design
 * docs/design/subscription-core-2026-10-07.md, 5.3 "SuperGrok track", X2b).
 *
 * Dormant: API handlers call into this module only when
 * `readSubscriptionCoreProviderRoute(..., "xai")` is `core`, which needs the
 * SuperGrok cutover receipt (X3); until then the binding is not registered
 * and every shared runtime refuses it. The pools, settings and writers are
 * the provider-neutral ones (`subscription-core/administration`,
 * `subscription-core/connections`); this module only projects neutral rows
 * into the legacy SuperGrok account shape and encodes a device-code sign-in
 * as the adapter's stored credential. Nothing here reads or writes a legacy
 * SuperGrok table or returns credential material.
 */
import type { Database } from "./database";
import { encryptEnvironmentValue } from "./environment-crypto";
import { decodeSubscriptionQuota } from "./subscription-core-repository";
import {
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCoreWorkspaceView,
  type SubscriptionCoreConnectionRow,
} from "./subscription-core/administration";
import {
  connectSubscriptionCoreConnection,
  type SubscriptionCoreConnectResult,
  type SubscriptionCoreConnectScope,
} from "./subscription-core/connections";
import {
  encodeSubscriptionCoreXaiCredential,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
  type SubscriptionCoreXaiTokens,
} from "./subscription-core-xai-adapter";
import type { XaiSubscriptionAccountMetadata } from "./xai-subscription";

export type SubscriptionCoreXaiScope = "workspace" | "user" | "organization";

function date(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

function epoch(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

/**
 * One core connection in the legacy SuperGrok account shape. The cutover
 * maps the legacy quota to one window (design 5.3, "Health and quota"), so
 * the first window is the legacy percentage and reset. Fields no SuperGrok
 * route projects (`version`, the allocator counters) are not carried.
 */
export function projectSubscriptionCoreXaiAccount(
  row: SubscriptionCoreConnectionRow,
  scope: SubscriptionCoreXaiScope,
  allocatorEnabled = row.allocator_enabled,
): XaiSubscriptionAccountMetadata {
  const quota = decodeSubscriptionQuota(row);
  const window = quota?.windows[0];
  return {
    id: row.id,
    scope,
    providerAccountId: row.provider_account_id,
    allowedModelIds: row.allowed_model_ids,
    label: row.label,
    accountEmail: row.account_email,
    planType: row.plan_type,
    status: row.status as XaiSubscriptionAccountMetadata["status"],
    allocatorEnabled,
    version: 0,
    allocatorVersion: Number(row.allocator_version),
    allocatorUpdatedAt: date(row.updated_at),
    expiresAt: date(row.expires_at),
    lastRefreshAt: date(row.last_refresh_at),
    lastError: row.last_error,
    quotaUsedPercent: window?.usedPercent ?? null,
    quotaResetAt: epoch(window?.resetsAt),
    quotaCheckedAt: epoch(quota?.observedAt),
    exhaustedUntil: epoch(quota?.exhaustedUntil),
    selectionCount: 0,
    lastSelectedAt: null,
    connectedBySubjectId: row.connected_by_subject_id,
  };
}

export type SubscriptionCoreXaiPoolProjection = {
  /**
   * The legacy pool name: `user` when the viewer's own personal connections
   * are listed (their Personal workspace), `organization` while an available
   * organization pool serves the workspace, else `workspace`.
   */
  source: SubscriptionCoreXaiScope;
  accounts: XaiSubscriptionAccountMetadata[];
  activeCredentialId: string | null;
  rotationEnabled: boolean;
};

/**
 * A workspace's SuperGrok pool for one viewer in the legacy shapes. Shared
 * connections carry the pool they serve this workspace from; personal ones
 * (listed only to their owner, only in the owner's Personal workspace) are
 * `user`.
 */
export async function getSubscriptionCoreXaiWorkspaceProjection(
  db: Database,
  input: { accountId: string; workspaceId: string; viewerSubjectId: string },
): Promise<SubscriptionCoreXaiPoolProjection> {
  const view = await readSubscriptionCoreWorkspaceView(db, SUBSCRIPTION_CORE_XAI, input);
  return {
    source:
      view.personal.length > 0
        ? "user"
        : // Legacy names the organization pool only while it serves the
          // workspace (an available organization pool); an empty one is `workspace`.
          view.pool.source.effectiveSource === "organization" &&
            view.pool.source.organizationAvailable
          ? "organization"
          : "workspace",
    accounts: [
      ...view.pool.connections.map((entry) =>
        projectSubscriptionCoreXaiAccount(
          entry.row,
          entry.source,
          entry.row.allocator_enabled && entry.poolAllocatorEnabled,
        ),
      ),
      ...view.personal.map((row) => projectSubscriptionCoreXaiAccount(row, "user")),
    ],
    activeCredentialId: view.primaryConnectionId,
    rotationEnabled: view.pool.rotationMode === "spread",
  };
}

/** The organization's own SuperGrok accounts and rotation; empty for a non-administrator. */
export async function getSubscriptionCoreXaiOrganizationProjection(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<SubscriptionCoreXaiPoolProjection> {
  const pool = await readSubscriptionCoreOrganizationPool(db, SUBSCRIPTION_CORE_XAI, input);
  return {
    source: "organization",
    accounts: (pool?.rows ?? []).map((row) =>
      projectSubscriptionCoreXaiAccount(row, "organization"),
    ),
    activeCredentialId: pool?.primaryConnectionId ?? null,
    rotationEnabled: pool ? pool.rotationMode === "spread" : false,
  };
}

/**
 * Connect (or reconnect) one SuperGrok account from a completed device-code
 * sign-in through the neutral connect writer: a personal connection in the
 * person's own Personal workspace (and only there for `personal`, a legacy
 * `user` scope), else a shared one. The stored credential
 * is the adapter's format; the token identity subject is both the upstream
 * account and the signed-in person. The caller delivers `wake` after commit.
 */
export async function connectSubscriptionCoreXaiConnection(
  db: Database,
  input: SubscriptionCoreConnectScope & {
    encryptionKey: Uint8Array;
    tokens: SubscriptionCoreXaiTokens;
    identitySubject: string;
    accountEmail: string | null;
    label: string | null;
    expiresAt: Date | null;
    connectedBySubjectId: string | null;
  },
): Promise<SubscriptionCoreConnectResult> {
  return await connectSubscriptionCoreConnection(db, SUBSCRIPTION_CORE_XAI, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ...(input.personal ? { personal: true } : {}),
    credentialEncrypted: encryptEnvironmentValue(
      input.encryptionKey,
      encodeSubscriptionCoreXaiCredential(input.tokens),
    ),
    credentialFormat: SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
    providerAccountId: input.identitySubject,
    providerSubjectId: input.identitySubject,
    planType: null,
    providerState: {},
    expiresAt: input.expiresAt,
    lastRefreshAt: new Date(),
    accountEmail: input.accountEmail,
    label: input.label,
    connectedBySubjectId: input.connectedBySubjectId,
  });
}
