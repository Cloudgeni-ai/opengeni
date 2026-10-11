import type { Settings } from "@opengeni/config";
import {
  readSubscriptionCoreProviderRouteForWorkspace,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
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
    scope: "workspace" | "organization";
  };
};

/**
 * The SuperGrok status after the cutover receipt (design 5.3, status
 * probe): the workspace's shared pool and its effective primary, validated
 * by one live model read through the adapter on that connection. Null
 * before the receipt (the caller keeps the legacy status); a maintenance
 * hold reports nothing usable. Personal connections are never listed.
 */
export async function readXaiCoreStatus<Model>(
  deps: { db: Database; settings: Settings },
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    models: () => Promise<Model[]>;
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
  const pool = await connections.readSubscriptionCoreWorkspaceConnections(deps.db, scope);
  const active = pool.connections.find(
    (connection) => connection.connectionId === pool.primaryConnectionId,
  );
  if (!active) {
    return {
      connected: pool.connections.length > 0,
      valid: false,
      accountCount: pool.connections.length,
    };
  }
  const probe = await connections.probeSubscriptionCoreConnectionLiveModels(
    deps.db,
    deps.settings,
    scope,
    active.connectionId,
    input.fetch ? { fetchImpl: input.fetch as typeof fetch } : {},
  );
  const valid = probe.kind === "read";
  return {
    connected: true,
    valid,
    accountCount: pool.connections.length,
    models: valid ? await input.models() : [],
    activeAccount: {
      id: active.connectionId,
      label: active.label,
      subject: active.providerAccountId,
      scope: active.source,
    },
  };
}
