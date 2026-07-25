import type { StreamConnectionState, WorkspaceControlEvent } from "@opengeni/sdk";
import { createContext, useContext } from "react";
import type {
  EmbeddedHumanInputSessionClientLike,
  EmbeddedSessionMcpApprovalPolicyClientLike,
  EmbeddedSessionClientLike,
  SessionClientLike,
} from "./client";

export type OpenGeniContextValue = {
  client: SessionClientLike;
  workspaceId: string;
  workspaceControlEvent: WorkspaceControlEvent | null;
  workspaceControlConnectionState: StreamConnectionState | "idle" | "error";
  registerSessionReconciler: (
    sessionId: string,
    key: string,
    reconcile: () => Promise<void>,
  ) => () => void;
  reconcileSession: (sessionId: string) => Promise<void>;
};

export const OpenGeniContext = createContext<OpenGeniContextValue | null>(null);

const NOOP_REGISTER_RECONCILER: OpenGeniContextValue["registerSessionReconciler"] = () => () =>
  undefined;
const NOOP_RECONCILE_SESSION: OpenGeniContextValue["reconcileSession"] = async () => undefined;

export type ClientOverride = {
  client?: SessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionClientOverride = {
  client?: EmbeddedSessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedHumanInputClientOverride = {
  client?: EmbeddedHumanInputSessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionMcpApprovalPolicyClientOverride = {
  client?: EmbeddedSessionMcpApprovalPolicyClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionContextValue = Omit<OpenGeniContextValue, "client"> & {
  client: EmbeddedSessionClientLike;
};

/** Resolve client + workspace from explicit overrides or the provider. */
export function useOpenGeni(override: ClientOverride = {}): OpenGeniContextValue {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: no OpenGeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  return {
    client,
    workspaceId,
    workspaceControlEvent: context?.workspaceControlEvent ?? null,
    workspaceControlConnectionState: context?.workspaceControlConnectionState ?? "idle",
    registerSessionReconciler: context?.registerSessionReconciler ?? NOOP_REGISTER_RECONCILER,
    reconcileSession: context?.reconcileSession ?? NOOP_RECONCILE_SESSION,
  };
}

/**
 * Resolve the narrow client required by the session-only hooks. The full
 * provider client is structurally compatible, while an explicit host proxy
 * only needs to expose session/event/composer/queue/control operations.
 */
export function useEmbeddedSession(
  override: EmbeddedSessionClientOverride = {},
): EmbeddedSessionContextValue {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: no OpenGeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  return {
    client,
    workspaceId,
    workspaceControlEvent: context?.workspaceControlEvent ?? null,
    workspaceControlConnectionState: context?.workspaceControlConnectionState ?? "idle",
    registerSessionReconciler: context?.registerSessionReconciler ?? NOOP_REGISTER_RECONCILER,
    reconcileSession: context?.reconcileSession ?? NOOP_RECONCILE_SESSION,
  };
}

/**
 * Resolve the structured-input refinement without widening the baseline
 * session-only proxy contract.
 */
export function useEmbeddedHumanInputSession(override: EmbeddedHumanInputClientOverride = {}): Omit<
  EmbeddedSessionContextValue,
  "client"
> & {
  client: EmbeddedHumanInputSessionClientLike;
} {
  const embedded = useEmbeddedSession(override);
  const client = embedded.client as Partial<EmbeddedHumanInputSessionClientLike>;
  if (
    typeof client.listHumanInputRequests !== "function" ||
    typeof client.getHumanInputRequest !== "function" ||
    typeof client.submitHumanInputResponse !== "function"
  ) {
    throw new Error(
      "@opengeni/react: useHumanInputRequests requires listHumanInputRequests, getHumanInputRequest, and submitHumanInputResponse.",
    );
  }
  return {
    ...embedded,
    client: client as EmbeddedHumanInputSessionClientLike,
  };
}

/** Resolve the approval-policy refinement without widening session-only hosts. */
export function useEmbeddedSessionMcpApprovalPolicy(
  override: EmbeddedSessionMcpApprovalPolicyClientOverride = {},
): Omit<EmbeddedSessionContextValue, "client"> & {
  client: EmbeddedSessionMcpApprovalPolicyClientLike;
} {
  const embedded = useEmbeddedSession(override);
  const client = embedded.client as Partial<EmbeddedSessionMcpApprovalPolicyClientLike>;
  if (typeof client.updateSessionMcpApprovalPolicy !== "function") {
    throw new Error(
      "@opengeni/react: useSessionMcpApprovalPolicy requires updateSessionMcpApprovalPolicy.",
    );
  }
  return {
    ...embedded,
    client: client as EmbeddedSessionMcpApprovalPolicyClientLike,
  };
}

/**
 * Resolve the client only — for hooks that are not workspace-scoped
 * (`useWorkspaces`, `useBillingUsage`).
 */
export function useOpenGeniClient(
  override: Pick<ClientOverride, "client"> = {},
): SessionClientLike {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  if (!client) {
    throw new Error(
      "@opengeni/react: no OpenGeni client available. Wrap the tree in <OpenGeniProvider> or pass { client } to the hook.",
    );
  }
  return client;
}
