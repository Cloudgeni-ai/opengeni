import { useCallback, useState } from "react";
import type {
  ModelAccountPreferences,
  SessionEvent,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
  SetSessionModelAccountChoiceResponse,
  UpdateModelAccountPreferencesRequest,
} from "@opengeni/sdk";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useMutationRunner,
  usePolledValue,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Events after which the session's model account may have changed. */
export function isModelAccountEvent(event: Pick<SessionEvent, "type">): boolean {
  return [
    "model_account.selection.changed",
    "codex.account.selection.changed",
    "subscription.account.selected",
    "subscription.account.switched",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "turn.requires_action",
    "session.status.changed",
  ].includes(event.type);
}

/**
 * The structural slice of the SDK client the model-account picker needs.
 * Method names and signatures match `OpenGeniClient`, so the real client
 * satisfies it directly and a test client can stand in.
 */
export type ModelAccountClientLike = {
  getSessionModelAccount: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<SessionModelAccountChoiceResponse>;
  setSessionModelAccount?: (
    workspaceId: string,
    sessionId: string,
    request: SetSessionModelAccountChoiceRequest,
  ) => Promise<SetSessionModelAccountChoiceResponse>;
  updateModelAccountPreferences?: (
    organizationId: string,
    request: UpdateModelAccountPreferencesRequest,
  ) => Promise<ModelAccountPreferences>;
};

export type UseSessionModelAccountOptions = ClientOverride &
  SessionEventFeedOptions & {
    sessionId: string;
    /** Scope choices, including Automatic, to this provider. Omit for a whole-session reset. */
    provider?: string | null | undefined;
    /** The session's organization; needed to change the personal-fallback opt-in. */
    organizationId?: string | null | undefined;
    pollIntervalMs?: number | undefined;
    modelAccountClient?: ModelAccountClientLike | undefined;
  };

export type UseSessionModelAccountResult = {
  choice: SessionModelAccountChoiceResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Choose an account, or `null` for automatic selection; true on success. */
  choose: (connectionId: string | null) => Promise<boolean>;
  choosing: boolean;
  /** The in-flight target (`null` is automatic; `undefined` when idle). */
  choosingTarget: string | null | undefined;
  appliedTo: "waiting_turn" | "next_turn" | null;
  /** Turn the caller's own personal-fallback opt-in on or off; true on success. */
  setFallbackOptIn: (optIn: boolean) => Promise<boolean>;
  canChangeFallback: boolean;
  mutationError: Error | null;
};

/**
 * The session's model account across every provider on the shared
 * subscription core: the accounts it may use (the workspace's shared accounts
 * and the caller's own personal accounts), the explicit choice, and the
 * caller's personal-fallback opt-in. The server decides what may be chosen;
 * this hook only reflects and requests.
 */
export function useSessionModelAccount(
  options: UseSessionModelAccountOptions,
): UseSessionModelAccountResult {
  const { client, workspaceId } = useOpenGeni(options);
  const accountClient = options.modelAccountClient ?? (client as unknown as ModelAccountClientLike);
  const { sessionId, organizationId, provider } = options;
  const sharedEvents = options.events;

  const load = useCallback(
    async () => await accountClient.getSessionModelAccount(workspaceId, sessionId),
    [accountClient, workspaceId, sessionId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const { run, mutating, mutationError } = useMutationRunner(sessionId);
  const [choosingTarget, setChoosingTarget] = useState<string | null | undefined>(undefined);
  const [receipt, setReceipt] = useState<{
    sessionId: string;
    appliedTo: "waiting_turn" | "next_turn";
  } | null>(null);

  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isModelAccountEvent,
    () => void refresh(),
    {
      enabled: options.enabled ?? true,
      ...(sharedEvents !== undefined ? { events: sharedEvents } : {}),
    },
  );

  const choose = useCallback(
    async (connectionId: string | null): Promise<boolean> => {
      if (!accountClient.setSessionModelAccount) return false;
      setChoosingTarget(connectionId);
      setReceipt(null);
      const result = await run(async () => {
        const response = await accountClient.setSessionModelAccount!(workspaceId, sessionId, {
          connectionId,
          ...(provider != null ? { provider } : {}),
        });
        setReceipt({ sessionId, appliedTo: response.appliedTo });
        return true;
      });
      setChoosingTarget(undefined);
      if (result) await refresh();
      return result === true;
    },
    [accountClient, workspaceId, sessionId, provider, run, refresh],
  );

  const canChangeFallback = Boolean(organizationId && accountClient.updateModelAccountPreferences);
  const setFallbackOptIn = useCallback(
    async (optIn: boolean): Promise<boolean> => {
      if (!organizationId || !accountClient.updateModelAccountPreferences) return false;
      const result = await run(async () => {
        await accountClient.updateModelAccountPreferences!(organizationId, {
          personalFallbackOptIn: optIn,
        });
        return true;
      });
      if (result) await refresh();
      return result === true;
    },
    [accountClient, organizationId, run, refresh],
  );

  return {
    // A failed reauthorization must not keep showing a previous session's accounts.
    choice: error ? null : data,
    loading,
    error,
    refresh,
    choose,
    choosing: mutating,
    choosingTarget,
    appliedTo: receipt?.sessionId === sessionId ? receipt.appliedTo : null,
    setFallbackOptIn,
    canChangeFallback,
    mutationError,
  };
}
