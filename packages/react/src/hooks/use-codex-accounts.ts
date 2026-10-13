import { useCallback, useState } from "react";
import type {
  CodexAccount,
  CodexAccountsResponse,
  CodexRotationSettings,
  CodexUsageMap,
  SessionCodexAccountsResponse,
  SessionEvent,
} from "@opengeni/sdk";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useMutationRunner,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";
import {
  invalidateSharedQueries,
  peekSharedQuery,
  sharedQueryWriter,
  useSharedQuery,
  useSharedQueryValue,
  type SharedQueryKey,
  type SharedQueryWriter,
} from "./shared-query";

/**
 * Shared-cache keys for Codex reads. Every surface that reads the same thing
 * through the same client (the session switcher, Settings > Models) shares one
 * entry, so a revisit renders the last rows at once and re-reads quietly.
 * Internal: not exported from the package root.
 */
export const codexAccountsQueryKey = (workspaceId: string, sessionId?: string | null) =>
  (sessionId
    ? ["codex-accounts", workspaceId, "session", sessionId]
    : ["codex-accounts", workspaceId]) as SharedQueryKey;
/** The last LIVE provider usage per account, written by every live usage read. */
export const codexLiveUsageQueryKey = (workspaceId: string) =>
  ["codex-live-usage", workspaceId] as SharedQueryKey;

/**
 * The last LIVE provider reading per account and when each one was taken. Only
 * live provider reads write it, never the server's cached limit columns.
 */
export type CodexLiveUsageSnapshot = {
  usage: CodexUsageMap;
  /** Epoch milliseconds of each account's reading. */
  readAt: Record<string, number>;
};

/**
 * Record live readings through a writer created before the read started.
 * `replace` is a read of every account (the batch); `merge` updates only the
 * accounts in `readings` and leaves the others' readings and times alone.
 */
export function recordCodexLiveUsage(
  write: SharedQueryWriter,
  scope: object,
  workspaceId: string,
  readings: CodexUsageMap,
  mode: "replace" | "merge",
): boolean {
  const key = codexLiveUsageQueryKey(workspaceId);
  const previous =
    mode === "merge" ? peekSharedQuery<CodexLiveUsageSnapshot>(scope, key)?.data : null;
  const now = Date.now();
  return write<CodexLiveUsageSnapshot>(key, {
    usage: { ...previous?.usage, ...readings },
    readAt: {
      ...previous?.readAt,
      ...Object.fromEntries(Object.keys(readings).map((id) => [id, now])),
    },
  });
}

/** When the oldest reading in the snapshot was taken (epoch ms), or null. */
function oldestReading(snapshot: CodexLiveUsageSnapshot | null | undefined): number | null {
  const times = Object.values(snapshot?.readAt ?? {});
  return times.length > 0 ? Math.min(...times) : null;
}

const liveUsageReads = new WeakMap<object, Map<string, Promise<CodexUsageMap>>>();

/** One live usage refresh per client + workspace at a time; joiners share it. */
function sharedLiveUsageRead(
  scope: object,
  workspaceId: string,
  read: () => Promise<{ usage: CodexUsageMap }>,
): Promise<CodexUsageMap> {
  let reads = liveUsageReads.get(scope);
  if (!reads) {
    reads = new Map();
    liveUsageReads.set(scope, reads);
  }
  const existing = reads.get(workspaceId);
  if (existing) return existing;
  // Bound to the identity epoch the read starts in: a clear meanwhile drops it.
  const write = sharedQueryWriter(scope);
  const request = read().then((fresh) => {
    recordCodexLiveUsage(write, scope, workspaceId, fresh.usage, "replace");
    return fresh.usage;
  });
  const settle = () => {
    if (reads!.get(workspaceId) === request) reads!.delete(workspaceId);
  };
  request.then(settle, settle);
  reads.set(workspaceId, request);
  return request;
}

/** Events that change which Codex account a session runs on (or just ran). */
export function isCodexAccountEvent(event: Pick<SessionEvent, "type">): boolean {
  return [
    "codex.credential.selected",
    "codex.account.switched",
    "codex.account.selection.changed",
    "model_account.selection.changed",
    "codex.capacity.waiting",
    "codex.capacity.resumed",
    "codex.capacity.superseded",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "turn.requires_action",
    "session.status.changed",
  ].includes(event.type);
}

/**
 * The structural slice of the SDK client the Codex-accounts surface needs. Method
 * NAMES + SIGNATURES match `OpenGeniClient` so the real client satisfies it
 * directly; declared structurally (not a hard Pick) so a test/Geni client can
 * stand in. `listSessionCodexAccounts` reads the accepted selection and choices
 * atomically; `pinSessionCodexAccount`
 * is the optional mutation (absent ⇒ the indicator hides the switch affordance).
 */
export type CodexAccountsClientLike = {
  listCodexAccounts: (workspaceId: string) => Promise<CodexAccountsResponse>;
  /** Required for session-scoped use; never fall back to another pool. */
  listSessionCodexAccounts?: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<SessionCodexAccountsResponse>;
  getSession?: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<{
    codexPinnedCredentialId?: string | null;
    codexLastCredentialId?: string | null;
    codexCurrentSelection?: { credentialId: string | null; waiting: boolean } | null;
  }>;
  pinSessionCodexAccount?: (
    workspaceId: string,
    sessionId: string,
    target: string,
  ) => Promise<{ pinned: string; appliedTo?: "waiting_turn" | "next_turn" }>;
  /** Optional (absent ⇒ the card hides live refresh): batched live /wham/usage refresh. */
  refreshCodexUsage?: (workspaceId: string) => Promise<{ usage: CodexUsageMap }>;
};

export type UseCodexAccountsOptions = ClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
    /** Scope to a session so the hook resolves the pin + the effective account. */
    sessionId?: string | undefined;
    /** Override the client with one implementing `CodexAccountsClientLike`. */
    codexClient?: CodexAccountsClientLike | undefined;
  };

export type UseCodexAccountsResult = {
  accounts: CodexAccount[];
  /** The ACTIVE account for the retry pool, or current workspace pool for new work. */
  activeAccountId: string | null;
  /** The session's PINNED account (null ⇒ following workspace active). */
  pinnedAccountId: string | null;
  /** Current preference only; automatic allocation can choose another account. */
  effectiveAccountId: string | null;
  currentSelection: { credentialId: string | null; waiting: boolean } | null;
  /** The accepted account can differ from the choices for the next turn. */
  currentAccount: CodexAccount | null;
  switchAppliedTo: "waiting_turn" | "next_turn" | null;
  /** The account the session's last turn ACTUALLY ran on (the "Running on:" source). */
  lastAccountId: string | null;
  settings: CodexRotationSettings;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /**
   * Trigger a LIVE batched /wham/usage refresh across all accounts, then re-read
   * the cached metadata so the new windows land on `accounts`. Modeled on `pin`.
   * No-op (resolves false) when the client can't refresh usage.
   * With `maxAgeMs`, live readings younger than that are reused instead.
   */
  refreshUsage: (options?: { maxAgeMs?: number | undefined }) => Promise<boolean>;
  /** Live provider readings override stale cached labels after refreshUsage. */
  liveUsage: CodexUsageMap;
  /** When the live readings in `liveUsage` were taken (epoch ms), or null. */
  liveUsageUpdatedAt: number | null;
  /** True while a live usage refresh is in flight (drives the bar skeleton). */
  refreshingUsage: boolean;
  /** Pin (or unpin via "auto") the session's account; returns true on success. */
  pin: (target: string) => Promise<boolean>;
  pinning: boolean;
  /** The target of the in-flight pin (for per-row spinner gating). */
  pinningTarget: string | null;
  mutationError: Error | null;
};

const EMPTY_USAGE: CodexUsageMap = {};

const EMPTY_SETTINGS: CodexRotationSettings = {
  rotationEnabled: false,
  rotationStrategy: "sharded",
  activeCredentialId: null,
};

type CodexAccountsState = {
  currentAccount: CodexAccount | null;
  currentSelection: { credentialId: string | null; waiting: boolean } | null;
  accounts: CodexAccount[];
  activeAccountId: string | null;
  settings: CodexRotationSettings;
  pinnedAccountId: string | null;
  lastAccountId: string | null;
};

const EMPTY_STATE: CodexAccountsState = {
  currentAccount: null,
  currentSelection: null,
  accounts: [],
  activeAccountId: null,
  settings: EMPTY_SETTINGS,
  pinnedAccountId: null,
  lastAccountId: null,
};

/**
 * The workspace's Codex accounts, or session-authorized retry/next-turn choices
 * and accepted current account. Reads go through the client-scoped shared cache
 * (`useSharedQuery`): a remount renders the retained rows at once and re-reads
 * in the background; slow polling plus the `codex.account.switched` event
 * trigger keep them current, and `pin` invalidates the workspace's entries.
 * Dual-consumer safe via the structural `CodexAccountsClientLike` surface.
 */
export function useCodexAccounts(options: UseCodexAccountsOptions = {}): UseCodexAccountsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const codexClient = options.codexClient ?? (client as unknown as CodexAccountsClientLike);
  const sessionId = options.sessionId;
  const sharedEvents = options.events;

  const load = useCallback(async (): Promise<
    CodexAccountsResponse | SessionCodexAccountsResponse
  > => {
    if (sessionId) {
      if (!codexClient.listSessionCodexAccounts)
        throw new Error("Session Codex account projection is unavailable");
      return await codexClient.listSessionCodexAccounts(workspaceId, sessionId);
    }
    return await codexClient.listCodexAccounts(workspaceId);
  }, [codexClient, workspaceId, sessionId]);

  const {
    data: response,
    loading,
    error,
    refresh,
  } = useSharedQuery(codexClient, codexAccountsQueryKey(workspaceId, sessionId), load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  // Never read on mount: only an explicit live refresh writes this entry.
  const liveUsageQuery = useSharedQueryValue<CodexLiveUsageSnapshot>(
    codexClient,
    codexLiveUsageQueryKey(workspaceId),
  );
  const loadedData: CodexAccountsState | null = !response
    ? null
    : sessionId
      ? (response as SessionCodexAccountsResponse)
      : {
          currentSelection: null,
          currentAccount: null,
          accounts: response.accounts,
          activeAccountId: response.activeAccountId,
          settings: response.settings,
          pinnedAccountId: null,
          lastAccountId: null,
        };
  const { run: runMutation, mutating: pinning, mutationError } = useMutationRunner();
  const { run: runUsageMutation, mutating: refreshingUsage } = useMutationRunner();
  const liveUsage = liveUsageQuery.data?.usage ?? EMPTY_USAGE;
  const [pinningTarget, setPinningTarget] = useState<string | null>(null);
  const [switchReceipt, setSwitchReceipt] = useState<{
    sessionId: string;
    appliedTo: "waiting_turn" | "next_turn";
  } | null>(null);

  // Refresh only after the durable post-selection event. `turn.started` is
  // emitted before account selection settles and races this authoritative read.
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isCodexAccountEvent,
    () => void refresh(),
    {
      enabled: options.enabled ?? true,
      ...(sharedEvents !== undefined ? { events: sharedEvents } : {}),
    },
  );

  const pin = useCallback(
    async (target: string): Promise<boolean> => {
      if (!sessionId || !codexClient.pinSessionCodexAccount) {
        return false;
      }
      setPinningTarget(target);
      setSwitchReceipt(null);
      const invalidated: { current: Promise<void> | null } = { current: null };
      const result = await runMutation(async () => {
        const receipt = await codexClient.pinSessionCodexAccount!(workspaceId, sessionId, target);
        // Every retained Codex read for this workspace may now be wrong. This
        // runs even if the component unmounted meanwhile (the runner then
        // resolves null), so no other surface keeps showing the old choice.
        invalidated.current = invalidateSharedQueries(
          codexClient,
          codexAccountsQueryKey(workspaceId),
        );
        setSwitchReceipt({ sessionId, appliedTo: receipt.appliedTo ?? "next_turn" });
        return true;
      });
      setPinningTarget(null);
      if (result) await invalidated.current;
      return result === true;
    },
    [codexClient, workspaceId, sessionId, runMutation],
  );

  // Live usage refresh: hit the batched provider read, then re-read cached
  // metadata so the fresh windows land on `accounts`. The provider read writes the
  // cache columns server-side; refresh() pulls them back. Concurrent callers share
  // one provider read, and `maxAgeMs` reuses readings that are recent enough for
  // every listed account (a single-account refresh elsewhere never counts for all).
  const listedAccountIds = response?.accounts.map((account) => account.id).join("\n") ?? null;
  const refreshUsage = useCallback(
    async (refreshOptions: { maxAgeMs?: number | undefined } = {}): Promise<boolean> => {
      if (!codexClient.refreshCodexUsage) {
        return false;
      }
      const maxAgeMs = refreshOptions.maxAgeMs;
      const retained = peekSharedQuery<CodexLiveUsageSnapshot>(
        codexClient,
        codexLiveUsageQueryKey(workspaceId),
      )?.data;
      const ids = listedAccountIds ? listedAccountIds.split("\n") : [];
      if (
        maxAgeMs !== undefined &&
        retained &&
        ids.length > 0 &&
        ids.every((id) => {
          const readAt = retained.readAt[id];
          return readAt !== undefined && Date.now() - readAt < maxAgeMs;
        })
      ) {
        return true;
      }
      const result = await runUsageMutation(async () => {
        await sharedLiveUsageRead(codexClient, workspaceId, () =>
          codexClient.refreshCodexUsage!(workspaceId),
        );
        return true;
      });
      if (result) await refresh();
      return result === true;
    },
    [codexClient, workspaceId, runUsageMutation, refresh, listedAccountIds],
  );

  // Reauthorization failure must remove a previously visible session pool.
  const data = (sessionId && error ? null : loadedData) ?? EMPTY_STATE;
  const effectiveAccountId = data.pinnedAccountId ?? data.activeAccountId;
  const withLiveUsage = (account: CodexAccount): CodexAccount => {
    const live = liveUsage[account.id]?.usage;
    return live ? { ...account, fiveHour: live.fiveHour, weekly: live.weekly } : account;
  };

  return {
    currentAccount: data.currentAccount ? withLiveUsage(data.currentAccount) : null,
    currentSelection: data.currentSelection,
    switchAppliedTo:
      switchReceipt?.sessionId === sessionId ? (switchReceipt?.appliedTo ?? null) : null,
    accounts: data.accounts.map(withLiveUsage),
    activeAccountId: data.activeAccountId,
    pinnedAccountId: data.pinnedAccountId,
    effectiveAccountId,
    lastAccountId: data.lastAccountId,
    settings: data.settings,
    loading,
    error,
    refresh,
    refreshUsage,
    liveUsage,
    liveUsageUpdatedAt: oldestReading(liveUsageQuery.data),
    refreshingUsage,
    pin,
    pinning,
    pinningTarget,
    mutationError,
  };
}
