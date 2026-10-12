import type { Settings } from "@opengeni/config";
import {
  deliverSubscriptionCoreProviderWake,
  readSubscriptionCoreProviderRouteForWorkspace,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreAdministeredConnections,
  subscriptionCoreOperationConnections,
  subscriptionCorePersonalConnections,
  workspaceXaiSubscriptionActive,
  type Database,
} from "@opengeni/db";

/**
 * Whether SuperGrok can serve a workspace-level operation (video funding,
 * realtime catalog, transcription). Before the SuperGrok cutover receipt
 * this is the legacy check for the caller's live pool; after it, "a shared
 * xAI candidate exists for this workspace": organization- or
 * workspace-scoped shared connections only, never the viewer's personal
 * accounts (design 5.3, EP-N11), and nothing while the organization is held
 * for maintenance.
 */
export async function workspaceXaiOperationAvailable(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
  });
  if (route === "legacy") {
    return await workspaceXaiSubscriptionActive(db, settings, input.workspaceId, input.subjectId);
  }
  if (route === "maintenance" || !settings.supergrokSubscriptionEnabled) return false;
  const candidates = await subscriptionCoreOperationConnections(
    SUBSCRIPTION_CORE_XAI,
  ).listSubscriptionCoreOperationCandidates(db, { kind: "workspace", ...input });
  return candidates.length > 0;
}

/** The SuperGrok status payload (unchanged shape on both paths). */
export type XaiStatusPayload<Model> = {
  connected: boolean;
  valid: boolean;
  accountCount: number;
  models?: Model[];
  activeAccount?: {
    id: string;
    label: string | null;
    subject: string | null;
    scope: "workspace" | "organization" | "user";
  };
};

/**
 * The SuperGrok status after the cutover receipt (design 5.3, status
 * probe): the workspace's shared pool and its effective primary, validated
 * by one live model read through the adapter on that connection. Null
 * before the receipt (the caller keeps the legacy status); a maintenance
 * hold reports nothing usable.
 *
 * The viewer's own personal connections count as connected wherever the
 * owner-only reader shows them. Only in the viewer's own Personal workspace,
 * only without a shared primary, and only for a caller who passes the
 * owner check of a private account (`ownerVerified`: the verified owning
 * person with `connections:write`, never a read-only key or an agent), is a
 * personal connection the effective account (legacy scope `user`),
 * validated by one live usage read as its owner there; that read also
 * applies the organization's personal-connections rule (0729). Any other
 * caller gets the stored count only, with no live read and no wake.
 * Another person's personal connections are never listed.
 */
export async function readXaiCoreStatus<Model>(
  deps: { db: Database; settings: Settings },
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    models: () => Promise<Model[]>;
    /** Asked only before a live personal read; false refuses it. */
    ownerVerified: () => Promise<boolean>;
    fetch?: unknown;
  },
): Promise<XaiStatusPayload<Model> | null> {
  const scope = {
    kind: "workspace" as const,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
  };
  const route = await readSubscriptionCoreProviderRouteForWorkspace(deps.db, {
    ...scope,
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
  });
  if (route === "legacy") return null;
  if (route === "maintenance") return { connected: false, valid: false, accountCount: 0 };
  const connections = subscriptionCoreOperationConnections(SUBSCRIPTION_CORE_XAI);
  const [pool, personal] = await Promise.all([
    connections.readSubscriptionCoreWorkspaceConnections(deps.db, scope),
    subscriptionCorePersonalConnections(
      SUBSCRIPTION_CORE_XAI,
    ).readSubscriptionCorePersonalConnections(deps.db, scope),
  ]);
  const accountCount = pool.connections.length + personal.connections.length;
  const fetchDeps = input.fetch ? { fetchImpl: input.fetch as typeof fetch } : {};
  const active = pool.connections.find(
    (connection) => connection.connectionId === pool.primaryConnectionId,
  );
  const ownActive = personal.ownPersonalWorkspace
    ? personal.connections.find((connection) => connection.status === "active")
    : undefined;
  if (!active && ownActive && (await input.ownerVerified())) {
    const probe = await subscriptionCoreAdministeredConnections(
      SUBSCRIPTION_CORE_XAI,
    ).probeSubscriptionCoreAdministeredConnectionUsage(
      deps.db,
      deps.settings,
      {
        kind: "personal_owner",
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
      },
      ownActive.connectionId,
      fetchDeps,
    );
    const valid = probe.kind === "read";
    if (probe.kind === "read" && probe.recovered) {
      // The reading is stored and may have ended an exhaustion: wake the
      // organization's SuperGrok core waiters. The reading already
      // committed, so a failed wake hint never fails the status (every core
      // waiter has its own recheck).
      await deliverSubscriptionCoreProviderWake(deps.db, SUBSCRIPTION_CORE_XAI_PROVIDER, {
        accountId: input.accountId,
        reason: "usage_recovered",
      }).catch(() => undefined);
    }
    return {
      connected: true,
      valid,
      accountCount,
      models: valid ? await input.models() : [],
      activeAccount: {
        id: ownActive.connectionId,
        label: ownActive.label,
        subject: ownActive.providerAccountId,
        scope: "user",
      },
    };
  }
  if (!active) {
    return { connected: accountCount > 0, valid: false, accountCount };
  }
  const probe = await connections.probeSubscriptionCoreConnectionLiveModels(
    deps.db,
    deps.settings,
    scope,
    active.connectionId,
    fetchDeps,
  );
  const valid = probe.kind === "read";
  return {
    connected: true,
    valid,
    accountCount,
    models: valid ? await input.models() : [],
    activeAccount: {
      id: active.connectionId,
      label: active.label,
      subject: active.providerAccountId,
      scope: active.source,
    },
  };
}
