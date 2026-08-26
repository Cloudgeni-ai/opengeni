import type {
  BrowserAccountsClientLike,
  ManagedAuthDeepLinkResolution,
  ManagedAuthLoginTransaction,
  ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type BrowserAccountTransitionPhase =
  | "preflight"
  | "blocked"
  | "committing"
  | "loading"
  | "ready"
  | "recoverable_error";

export type BrowserAccountTransitionKind =
  | "add"
  | "select"
  | "logout_one"
  | "logout_all"
  | "reauth"
  | "cross_tab";

export type BrowserAccountTransitionBlocker = {
  id: string;
  label: string;
  detail?: string | undefined;
};

export type BrowserAccountTransition = {
  kind: BrowserAccountTransitionKind;
  from: ManagedAuthSessionSetProjection | null;
  to: ManagedAuthSessionSetProjection | null;
  signal: AbortSignal;
};

export type BrowserAccountsProviderProps = {
  client: BrowserAccountsClientLike;
  /**
   * Hide the authenticated tree, abort old actor work, clear tenant-bound
   * state, recreate credentials/clients, and refetch principal access here.
   */
  onActorTransition: (transition: BrowserAccountTransition) => Promise<void>;
  children?: ReactNode;
  broadcastChannelName?: string | null | undefined;
  /** Adopt the already-authenticated legacy provider session during dual-mode rollout. */
  bootstrapLegacySession?: boolean | undefined;
};

type BlockerInspector = () => BrowserAccountTransitionBlocker | null;

type PendingNonSecretTransition = {
  kind: Exclude<BrowserAccountTransitionKind, "add" | "reauth" | "cross_tab">;
  operationId: string;
  execute: (
    projection: ManagedAuthSessionSetProjection,
  ) => Promise<ManagedAuthSessionSetProjection | null>;
};

export type BrowserAccountsContextValue = {
  projection: ManagedAuthSessionSetProjection | null;
  phase: BrowserAccountTransitionPhase;
  blockers: BrowserAccountTransitionBlocker[];
  error: Error | null;
  transaction: ManagedAuthLoginTransaction | null;
  hasPendingTransition: boolean;
  refresh: () => Promise<ManagedAuthSessionSetProjection | null>;
  invalidateActor: () => Promise<ManagedAuthSessionSetProjection | null>;
  registerTransitionBlocker: (id: string, inspect: BlockerInspector) => () => void;
  continueTransition: () => Promise<boolean>;
  cancelPendingTransition: () => void;
  beginAdd: (returnIntent?: string | undefined) => Promise<ManagedAuthLoginTransaction>;
  beginReauth: (
    slotId: string,
    returnIntent?: string | undefined,
  ) => Promise<ManagedAuthLoginTransaction>;
  completeEmailPassword: (input: { email: string; password: string }) => Promise<boolean>;
  settleExternalLoginTransaction: (transactionId: string) => Promise<boolean>;
  cancelLoginTransaction: () => Promise<void>;
  selectSlot: (slotId: string) => Promise<boolean>;
  logoutSlot: (slotId: string, replacementSlotId: string | null) => Promise<boolean>;
  logoutAll: () => Promise<boolean>;
  resolveDeepLink: (path: string) => Promise<ManagedAuthDeepLinkResolution>;
};

const BrowserAccountsContext = createContext<BrowserAccountsContextValue | null>(null);
const DEFAULT_CHANNEL = "opengeni:browser-account-epoch:v1";

function operationId(): string {
  return crypto.randomUUID();
}

function sameActor(
  left: ManagedAuthSessionSetProjection | null,
  right: ManagedAuthSessionSetProjection | null,
): boolean {
  return (
    left?.generation === right?.generation &&
    left?.actorEpoch === right?.actorEpoch &&
    left?.selectedSlotId === right?.selectedSlotId &&
    left?.state === right?.state
  );
}

function sameSelectedActor(
  left: ManagedAuthSessionSetProjection | null,
  right: ManagedAuthSessionSetProjection | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.actorEpoch === right.actorEpoch &&
    left.selectedSlotId === right.selectedSlotId &&
    left.state === right.state
  );
}

function compareCounter(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isOlderProjection(
  candidate: ManagedAuthSessionSetProjection,
  current: ManagedAuthSessionSetProjection,
): boolean {
  const epoch = compareCounter(candidate.actorEpoch, current.actorEpoch);
  return epoch < 0 || (epoch === 0 && compareCounter(candidate.generation, current.generation) < 0);
}

function accountError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Browser account operation failed");
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function needsReconciliation(error: unknown): boolean {
  return new Set(["actor_change_required", "generation_conflict", "operation_outcome_unknown"]).has(
    errorCode(error) ?? "",
  );
}

export function BrowserAccountsProvider({
  client,
  onActorTransition,
  children,
  broadcastChannelName = DEFAULT_CHANNEL,
  bootstrapLegacySession = false,
}: BrowserAccountsProviderProps) {
  const [projection, setProjection] = useState<ManagedAuthSessionSetProjection | null>(null);
  const [phase, setPhase] = useState<BrowserAccountTransitionPhase>("loading");
  const [blockers, setBlockers] = useState<BrowserAccountTransitionBlocker[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [transaction, setTransaction] = useState<ManagedAuthLoginTransaction | null>(null);
  const projectionRef = useRef(projection);
  const transactionRef = useRef(transaction);
  const blockerInspectorsRef = useRef(new Map<string, BlockerInspector>());
  const pendingRef = useRef<PendingNonSecretTransition | null>(null);
  const transactionTargetSlotIdRef = useRef<string | null>(null);
  const beginOperationRef = useRef<{ signature: string; operationId: string } | null>(null);
  const bootstrapOperationRef = useRef<{ generation: string; operationId: string } | null>(null);
  const completionOperationIdRef = useRef<string | null>(null);
  const cancelOperationIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const transitionAbortRef = useRef<AbortController | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  projectionRef.current = projection;
  transactionRef.current = transaction;

  const inspectBlockers = useCallback((): BrowserAccountTransitionBlocker[] => {
    const current = [...blockerInspectorsRef.current.entries()]
      .map(([id, inspect]) => {
        const blocker = inspect();
        return blocker ? { ...blocker, id } : null;
      })
      .filter((value): value is BrowserAccountTransitionBlocker => value !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
    setBlockers(current);
    return current;
  }, []);

  const publishActorHint = useCallback((next: ManagedAuthSessionSetProjection | null) => {
    if (!next) return;
    channelRef.current?.postMessage({
      type: "actor-epoch-changed",
      generation: next.generation,
      actorEpoch: next.actorEpoch,
    });
  }, []);

  const settleActorTransition = useCallback(
    async (
      kind: BrowserAccountTransitionKind,
      from: ManagedAuthSessionSetProjection | null,
      accepted: ManagedAuthSessionSetProjection | null,
      sequence: number,
      publish: boolean,
    ): Promise<ManagedAuthSessionSetProjection | null> => {
      let target = accepted;
      if (from && target && isOlderProjection(target, from)) {
        target = await client.getSessionSet();
        if (sequenceRef.current !== sequence) return null;
        if (isOlderProjection(target, from)) {
          throw new Error("Browser account response regressed the accepted actor epoch");
        }
      }
      if (sameSelectedActor(from, target)) {
        setProjection(target);
        setPhase("ready");
        setError(null);
        return target;
      }
      transitionAbortRef.current?.abort();
      const controller = new AbortController();
      transitionAbortRef.current = controller;
      setPhase("loading");
      await onActorTransition({ kind, from, to: target, signal: controller.signal });
      if (controller.signal.aborted || sequenceRef.current !== sequence) return null;
      if (!target) {
        setProjection(null);
        setPhase("ready");
        setError(null);
        return null;
      }
      const confirmed = await client.getSessionSet();
      if (controller.signal.aborted || sequenceRef.current !== sequence) return null;
      if (isOlderProjection(confirmed, target) || !sameActor(target, confirmed)) {
        throw new Error("Browser actor changed again while tenant state was loading");
      }
      setProjection(confirmed);
      setPhase("ready");
      setError(null);
      if (publish) publishActorHint(confirmed);
      return confirmed;
    },
    [client, onActorTransition, publishActorHint],
  );

  const reconcile = useCallback(
    async (kind: BrowserAccountTransitionKind, publish = false) => {
      const sequence = ++sequenceRef.current;
      const before = projectionRef.current;
      setPhase("loading");
      let first = await client.getSessionSet();
      if (sequenceRef.current !== sequence) return null;
      if (
        bootstrapLegacySession &&
        first.mode === "dual" &&
        first.selectedSlotId === null &&
        first.slots.length === 0
      ) {
        const bootstrapOperation =
          bootstrapOperationRef.current?.generation === first.generation
            ? bootstrapOperationRef.current.operationId
            : operationId();
        bootstrapOperationRef.current = {
          generation: first.generation,
          operationId: bootstrapOperation,
        };
        try {
          first = await client.bootstrapSessionSet({
            operationId: bootstrapOperation,
            expectedGeneration: first.generation,
          });
          bootstrapOperationRef.current = null;
        } catch (caught) {
          if (!needsReconciliation(caught)) throw caught;
          const reconciled = await client.getSessionSet();
          if (sequenceRef.current !== sequence) return null;
          if (reconciled.selectedSlotId === null || reconciled.slots.length === 0) throw caught;
          first = reconciled;
          bootstrapOperationRef.current = null;
        }
      }
      if (before && isOlderProjection(first, before)) {
        setProjection(before);
        setPhase("ready");
        return before;
      }
      if (sameActor(before, first) || sameSelectedActor(before, first)) {
        setProjection(first);
        setPhase("ready");
        setError(null);
        return first;
      }
      return await settleActorTransition(kind, before, first, sequence, publish);
    },
    [bootstrapLegacySession, client, settleActorTransition],
  );

  const fail = useCallback(
    async (caught: unknown, kind: BrowserAccountTransitionKind): Promise<never> => {
      const nextError = accountError(caught);
      if (needsReconciliation(caught)) {
        try {
          await reconcile(kind);
        } catch {
          // Preserve the original typed failure; a manual refresh remains available.
        }
      }
      setError(nextError);
      setPhase("recoverable_error");
      throw nextError;
    },
    [reconcile],
  );

  const executePending = useCallback(
    async (pending: PendingNonSecretTransition): Promise<boolean> => {
      const blocked = inspectBlockers();
      if (blocked.length > 0) {
        pendingRef.current = pending;
        setPhase("blocked");
        return false;
      }
      const current = projectionRef.current;
      if (!current) throw new Error("Browser session set is not loaded");
      const sequence = ++sequenceRef.current;
      pendingRef.current = pending;
      setPhase("committing");
      setError(null);
      try {
        const accepted = await pending.execute(current);
        if (sequenceRef.current !== sequence) return false;
        pendingRef.current = null;
        if (sameSelectedActor(current, accepted)) {
          setProjection(accepted);
          setPhase("ready");
          setError(null);
        } else {
          await settleActorTransition(pending.kind, current, accepted, sequence, true);
        }
        return true;
      } catch (caught) {
        await fail(caught, pending.kind);
      }
    },
    [fail, inspectBlockers, settleActorTransition],
  );

  const refresh = useCallback(async () => {
    try {
      return await reconcile("cross_tab");
    } catch (caught) {
      const nextError = accountError(caught);
      setError(nextError);
      setPhase("recoverable_error");
      throw nextError;
    }
  }, [reconcile]);

  const invalidateActor = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    const before = projectionRef.current;
    transitionAbortRef.current?.abort();
    projectionRef.current = null;
    setProjection(null);
    setPhase("loading");
    setError(null);
    try {
      const accepted = await client.getSessionSet();
      if (sequenceRef.current !== sequence) return null;
      return await settleActorTransition("cross_tab", before, accepted, sequence, false);
    } catch (caught) {
      if (sequenceRef.current !== sequence) return null;
      const nextError = accountError(caught);
      setError(nextError);
      setPhase("recoverable_error");
      throw nextError;
    }
  }, [client, settleActorTransition]);

  const registerTransitionBlocker = useCallback((id: string, inspect: BlockerInspector) => {
    if (!id.trim()) throw new Error("Browser account transition blocker id is required");
    blockerInspectorsRef.current.set(id, inspect);
    return () => {
      if (blockerInspectorsRef.current.get(id) === inspect) {
        blockerInspectorsRef.current.delete(id);
      }
    };
  }, []);

  const continueTransition = useCallback(async (): Promise<boolean> => {
    const pending = pendingRef.current;
    return pending ? await executePending(pending) : false;
  }, [executePending]);

  const cancelPendingTransition = useCallback(() => {
    pendingRef.current = null;
    setBlockers([]);
    setPhase(projectionRef.current ? "ready" : "loading");
  }, []);

  const beginLogin = useCallback(
    async (kind: "add" | "reauth", slotId?: string, returnIntent?: string) => {
      const current = projectionRef.current;
      if (!current) throw new Error("Browser session set is not loaded");
      if (kind === "reauth" && slotId === current.selectedSlotId && inspectBlockers().length > 0) {
        setPhase("blocked");
        throw new Error("Settle account transition blockers before re-authenticating");
      }
      setPhase("committing");
      setError(null);
      const signature = JSON.stringify([
        kind,
        slotId ?? null,
        returnIntent ?? null,
        current.generation,
      ]);
      const beginOperation =
        beginOperationRef.current?.signature === signature
          ? beginOperationRef.current.operationId
          : operationId();
      beginOperationRef.current = { signature, operationId: beginOperation };
      try {
        const next = await client.beginLoginTransaction({
          operationId: beginOperation,
          expectedGeneration: current.generation,
          kind,
          ...(slotId ? { slotId } : {}),
          ...(returnIntent ? { returnIntent } : {}),
        });
        beginOperationRef.current = null;
        transactionTargetSlotIdRef.current = slotId ?? null;
        completionOperationIdRef.current = null;
        cancelOperationIdRef.current = null;
        setTransaction(next);
        setPhase("ready");
        return next;
      } catch (caught) {
        await fail(caught, kind);
      }
    },
    [client, fail, inspectBlockers],
  );

  const beginAdd = useCallback(
    async (returnIntent?: string) => await beginLogin("add", undefined, returnIntent),
    [beginLogin],
  );
  const beginReauth = useCallback(
    async (slotId: string, returnIntent?: string) =>
      await beginLogin("reauth", slotId, returnIntent),
    [beginLogin],
  );

  const completeEmailPassword = useCallback(
    async (input: { email: string; password: string }): Promise<boolean> => {
      const current = projectionRef.current;
      const activeTransaction = transactionRef.current;
      if (!current || !activeTransaction) throw new Error("No browser login transaction is active");
      const selectedReauth =
        activeTransaction.kind === "reauth" &&
        transactionTargetSlotIdRef.current !== null &&
        transactionTargetSlotIdRef.current === current.selectedSlotId;
      if (selectedReauth && inspectBlockers().length > 0) {
        setPhase("blocked");
        return false;
      }
      const sequence = ++sequenceRef.current;
      setPhase("committing");
      setError(null);
      const completionOperation = completionOperationIdRef.current ?? operationId();
      completionOperationIdRef.current = completionOperation;
      try {
        const completed = await client.completeEmailPasswordTransaction({
          operationId: completionOperation,
          expectedGeneration: current.generation,
          transactionId: activeTransaction.id,
          email: input.email,
          password: input.password,
        });
        if (sequenceRef.current !== sequence) return false;
        completionOperationIdRef.current = null;
        cancelOperationIdRef.current = null;
        transactionTargetSlotIdRef.current = null;
        setTransaction(null);
        const actorChanged = completed.projection.actorEpoch !== current.actorEpoch;
        if (actorChanged) {
          await settleActorTransition(
            activeTransaction.kind,
            current,
            completed.projection,
            sequence,
            true,
          );
        } else {
          setProjection(completed.projection);
          setPhase("ready");
        }
        return true;
      } catch (caught) {
        await fail(caught, activeTransaction.kind);
      }
    },
    [client, fail, inspectBlockers, settleActorTransition],
  );

  const settleExternalLoginTransaction = useCallback(
    async (transactionId: string): Promise<boolean> => {
      const activeTransaction = transactionRef.current;
      if (!activeTransaction || activeTransaction.id !== transactionId) return false;
      try {
        await reconcile(activeTransaction.kind, true);
        if (transactionRef.current?.id !== transactionId) return false;
        completionOperationIdRef.current = null;
        cancelOperationIdRef.current = null;
        transactionTargetSlotIdRef.current = null;
        setTransaction(null);
        return true;
      } catch (caught) {
        const nextError = accountError(caught);
        setError(nextError);
        setPhase("recoverable_error");
        throw nextError;
      }
    },
    [reconcile],
  );

  const cancelLoginTransaction = useCallback(async () => {
    const current = projectionRef.current;
    const activeTransaction = transactionRef.current;
    if (!current || !activeTransaction) return;
    setPhase("committing");
    const cancelOperation = cancelOperationIdRef.current ?? operationId();
    cancelOperationIdRef.current = cancelOperation;
    try {
      const next = await client.cancelLoginTransaction({
        operationId: cancelOperation,
        expectedGeneration: current.generation,
        transactionId: activeTransaction.id,
      });
      completionOperationIdRef.current = null;
      cancelOperationIdRef.current = null;
      transactionTargetSlotIdRef.current = null;
      setTransaction(null);
      setProjection(next);
      setPhase("ready");
      setError(null);
    } catch (caught) {
      await fail(caught, activeTransaction.kind);
    }
  }, [client, fail]);

  const selectSlot = useCallback(
    async (slotId: string) => {
      const id = operationId();
      return await executePending({
        kind: "select",
        operationId: id,
        execute: async (current) =>
          await client.selectLoginSlot({
            operationId: id,
            expectedGeneration: current.generation,
            slotId,
          }),
      });
    },
    [client, executePending],
  );

  const logoutSlot = useCallback(
    async (slotId: string, replacementSlotId: string | null) => {
      const id = operationId();
      return await executePending({
        kind: "logout_one",
        operationId: id,
        execute: async (current) =>
          await client.logoutLoginSlot({
            operationId: id,
            expectedGeneration: current.generation,
            slotId,
            replacementSlotId,
          }),
      });
    },
    [client, executePending],
  );

  const logoutAll = useCallback(async () => {
    const id = operationId();
    return await executePending({
      kind: "logout_all",
      operationId: id,
      execute: async (current) => {
        await client.logoutSessionSet({ operationId: id, expectedGeneration: current.generation });
        return null;
      },
    });
  }, [client, executePending]);

  const resolveDeepLink = useCallback(
    async (path: string) => await client.resolveDeepLink({ path }),
    [client],
  );

  useEffect(() => {
    const sequence = sequenceRef;
    const transitionAbort = transitionAbortRef;
    void refresh().catch((caught) => {
      setError(accountError(caught));
      setPhase("recoverable_error");
    });
    return () => {
      ++sequence.current;
      transitionAbort.current?.abort();
    };
  }, [client, refresh]);

  useEffect(() => {
    if (!broadcastChannelName || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(broadcastChannelName);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== "object") return;
      const hint = value as { type?: unknown; actorEpoch?: unknown; generation?: unknown };
      if (
        hint.type !== "actor-epoch-changed" ||
        typeof hint.actorEpoch !== "string" ||
        typeof hint.generation !== "string" ||
        (hint.actorEpoch === projectionRef.current?.actorEpoch &&
          hint.generation === projectionRef.current?.generation)
      ) {
        return;
      }
      void invalidateActor().catch(() => undefined);
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [broadcastChannelName, invalidateActor]);

  const value = useMemo<BrowserAccountsContextValue>(
    () => ({
      projection,
      phase,
      blockers,
      error,
      transaction,
      hasPendingTransition: pendingRef.current !== null,
      refresh,
      invalidateActor,
      registerTransitionBlocker,
      continueTransition,
      cancelPendingTransition,
      beginAdd,
      beginReauth,
      completeEmailPassword,
      settleExternalLoginTransaction,
      cancelLoginTransaction,
      selectSlot,
      logoutSlot,
      logoutAll,
      resolveDeepLink,
    }),
    [
      projection,
      phase,
      blockers,
      error,
      transaction,
      refresh,
      invalidateActor,
      registerTransitionBlocker,
      continueTransition,
      cancelPendingTransition,
      beginAdd,
      beginReauth,
      completeEmailPassword,
      settleExternalLoginTransaction,
      cancelLoginTransaction,
      selectSlot,
      logoutSlot,
      logoutAll,
      resolveDeepLink,
    ],
  );

  return (
    <BrowserAccountsContext.Provider value={value}>{children}</BrowserAccountsContext.Provider>
  );
}

export function useBrowserAccounts(): BrowserAccountsContextValue {
  const context = useContext(BrowserAccountsContext);
  if (!context) {
    throw new Error(
      "@opengeni/react/accounts: wrap the tree in <BrowserAccountsProvider> before using account hooks",
    );
  }
  return context;
}

/** Read the optional controller without requiring non-legacy hosts to mount it. */
export function useOptionalBrowserAccounts(): BrowserAccountsContextValue | null {
  return useContext(BrowserAccountsContext);
}

export function useBrowserAccountTransitionBlocker(id: string, inspect: BlockerInspector): void {
  const { registerTransitionBlocker } = useBrowserAccounts();
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  useEffect(
    () => registerTransitionBlocker(id, () => inspectRef.current()),
    [id, registerTransitionBlocker],
  );
}

/** No-op on legacy hosts that do not mount the optional accounts provider. */
export function useOptionalBrowserAccountTransitionBlocker(
  id: string,
  inspect: BlockerInspector,
): void {
  const context = useContext(BrowserAccountsContext);
  const registerTransitionBlocker = context?.registerTransitionBlocker;
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  useEffect(() => {
    if (!registerTransitionBlocker) return;
    return registerTransitionBlocker(id, () => inspectRef.current());
  }, [id, registerTransitionBlocker]);
}
