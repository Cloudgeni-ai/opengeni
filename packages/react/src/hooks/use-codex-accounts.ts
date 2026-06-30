import { useCallback, useState } from "react";
import type { CodexAccount, CodexAccountsResponse, CodexRotationSettings, SessionEvent } from "@opengeni/sdk";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue, useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

/** Events that change which Codex account a session runs on (or just ran). */
export function isCodexAccountEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type === "codex.account.switched" || event.type === "turn.started";
}

/**
 * The structural slice of the SDK client the Codex-accounts surface needs. Method
 * NAMES + SIGNATURES match `OpenGeniClient` so the real client satisfies it
 * directly; declared structurally (not a hard Pick) so a test/Geni client can
 * stand in. `getSession` reads the session's pin/last; `pinSessionCodexAccount`
 * is the optional mutation (absent ⇒ the indicator hides the switch affordance).
 */
export type CodexAccountsClientLike = {
  listCodexAccounts: (workspaceId: string) => Promise<CodexAccountsResponse>;
  getSession?: (workspaceId: string, sessionId: string) => Promise<{ codexPinnedCredentialId?: string | null; codexLastCredentialId?: string | null }>;
  pinSessionCodexAccount?: (workspaceId: string, sessionId: string, target: string) => Promise<{ pinned: string }>;
};

export type UseCodexAccountsOptions = ClientOverride & SessionEventFeedOptions & {
  pollIntervalMs?: number | undefined;
  /** Scope to a session so the hook resolves the pin + the effective account. */
  sessionId?: string | undefined;
  /** Override the client with one implementing `CodexAccountsClientLike`. */
  codexClient?: CodexAccountsClientLike | undefined;
};

export type UseCodexAccountsResult = {
  accounts: CodexAccount[];
  /** The workspace ACTIVE account (used when a session is unpinned). */
  activeAccountId: string | null;
  /** The session's PINNED account (null ⇒ following workspace active). */
  pinnedAccountId: string | null;
  /** The account the next turn will run on: pin > workspace active. */
  effectiveAccountId: string | null;
  /** The account the session's last turn ACTUALLY ran on (the "Running on:" source). */
  lastAccountId: string | null;
  settings: CodexRotationSettings;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Pin (or unpin via "auto") the session's account; returns true on success. */
  pin: (target: string) => Promise<boolean>;
  pinning: boolean;
  /** The target of the in-flight pin (for per-row spinner gating). */
  pinningTarget: string | null;
  mutationError: Error | null;
};

const EMPTY_SETTINGS: CodexRotationSettings = { rotationEnabled: false, rotationStrategy: "most_remaining", activeCredentialId: null };

type CodexAccountsState = {
  accounts: CodexAccount[];
  activeAccountId: string | null;
  settings: CodexRotationSettings;
  pinnedAccountId: string | null;
  lastAccountId: string | null;
};

const EMPTY_STATE: CodexAccountsState = {
  accounts: [],
  activeAccountId: null,
  settings: EMPTY_SETTINGS,
  pinnedAccountId: null,
  lastAccountId: null,
};

/**
 * The workspace's Codex accounts + the per-workspace active pointer + (when
 * session-scoped) the session pin and last-ran-on account. Composed like
 * `useMachines`: slow polling (the realtime work is done by the
 * `codex.account.switched` / `turn.started` event trigger) + a `pin` mutation.
 * Dual-consumer safe via the structural `CodexAccountsClientLike` surface.
 */
export function useCodexAccounts(options: UseCodexAccountsOptions = {}): UseCodexAccountsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const codexClient = (options.codexClient ?? (client as unknown as CodexAccountsClientLike));
  const sessionId = options.sessionId;
  const sharedEvents = options.events;

  const load = useCallback(async (): Promise<CodexAccountsState> => {
    const accountsP = codexClient.listCodexAccounts(workspaceId);
    const sessionP = sessionId && codexClient.getSession
      ? codexClient.getSession(workspaceId, sessionId).catch(() => null)
      : Promise.resolve(null);
    const [acc, session] = await Promise.all([accountsP, sessionP]);
    return {
      accounts: acc.accounts,
      activeAccountId: acc.activeAccountId,
      settings: acc.settings,
      pinnedAccountId: session?.codexPinnedCredentialId ?? null,
      lastAccountId: session?.codexLastCredentialId ?? null,
    };
  }, [codexClient, workspaceId, sessionId]);

  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  const mutation = useMutationRunner();
  const [pinningTarget, setPinningTarget] = useState<string | null>(null);

  // Live flip: a manual switch (P1) or a failover (P3) emits codex.account.switched;
  // turn.started covers the case where the worker recorded the actual account.
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isCodexAccountEvent,
    () => void state.refresh(),
    { enabled: options.enabled ?? true, ...(sharedEvents !== undefined ? { events: sharedEvents } : {}) },
  );

  const pin = useCallback(
    async (target: string): Promise<boolean> => {
      if (!sessionId || !codexClient.pinSessionCodexAccount) {
        return false;
      }
      setPinningTarget(target);
      const result = await mutation.run(async () => {
        await codexClient.pinSessionCodexAccount!(workspaceId, sessionId, target);
        return true;
      });
      setPinningTarget(null);
      if (result) await state.refresh();
      return result === true;
    },
    [codexClient, workspaceId, sessionId, mutation.run, state.refresh],
  );

  const data = state.data ?? EMPTY_STATE;
  const effectiveAccountId = data.pinnedAccountId ?? data.activeAccountId;

  return {
    accounts: data.accounts,
    activeAccountId: data.activeAccountId,
    pinnedAccountId: data.pinnedAccountId,
    effectiveAccountId,
    lastAccountId: data.lastAccountId,
    settings: data.settings,
    loading: state.loading,
    refresh: state.refresh,
    pin,
    pinning: mutation.mutating,
    pinningTarget,
    mutationError: mutation.mutationError,
  };
}
