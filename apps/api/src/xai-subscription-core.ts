import type { Settings } from "@opengeni/config";
import {
  readSubscriptionCoreProviderRouteForWorkspace,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  type Database,
} from "@opengeni/db";

/**
 * Whether SuperGrok can serve a workspace-level operation (video funding,
 * realtime catalog, transcription): "a shared xAI candidate exists for
 * this workspace" on the shared core, organization- or workspace-scoped
 * shared connections only, never the viewer's personal accounts (design 5.3,
 * EP-N11). Any route other than `core` (maintenance, or no receipt, which
 * this binary's readiness check refuses) serves nothing.
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
  if (route !== "core" || !settings.supergrokSubscriptionEnabled) return false;
  const candidates = await subscriptionCoreOperationConnections(
    SUBSCRIPTION_CORE_XAI,
  ).listSubscriptionCoreOperationCandidates(db, { kind: "workspace", ...input });
  return candidates.length > 0;
}

/** The SuperGrok status payload. */
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
 * The SuperGrok status on the shared core (design 5.3, status probe): the
 * workspace's shared pool and its effective primary, validated by one live
 * model read through the adapter on that connection. Any route other than
 * `core` reports nothing usable. Personal connections are never listed.
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
): Promise<XaiStatusPayload<Model>> {
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
  if (route !== "core") return { connected: false, valid: false, accountCount: 0 };
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
