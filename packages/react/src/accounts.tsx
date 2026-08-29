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
   * Cross-tab/server invalidation first calls this with `to: null` as a
   * neutral fence before authority is reread, then calls it with the accepted
   * projection after the new actor is known.
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
  expectedGeneration: string | null;
  changesActor: (projection: ManagedAuthSessionSetProjection) => boolean;
  execute: (expectedGeneration: string) => Promise<ManagedAuthSessionSetProjection>;
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
const CROSS_TAB_ACTOR_HOLD_MS = 30_000;

async function yieldToCrossTabActorHold(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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

function supersededOperationError(): Error {
  const error = new Error("Browser account operation was superseded by an actor change");
  error.name = "AbortError";
  return error;
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
  const completionOperationRef = useRef<{
    operationId: string;
    expectedGeneration: string;
  } | null>(null);
  const cancelOperationRef = useRef<{
    operationId: string;
    expectedGeneration: string;
  } | null>(null);
  const pendingCommitSequenceRef = useRef<number | null>(null);
  const pendingServerMutationSequenceRef = useRef<number | null>(null);
  const invalidatedDuringPendingCommitRef = useRef(false);
  const sequenceRef = useRef(0);
  const transitionAbortRef = useRef<AbortController | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const crossTabActorHoldsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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

  const publishActorHold = useCallback(
    (transitionId: string, current: ManagedAuthSessionSetProjection) => {
      channelRef.current?.postMessage({
        type: "actor-transition-pending",
        transitionId,
        generation: current.generation,
        actorEpoch: current.actorEpoch,
      });
    },
    [],
  );

  const publishActorRelease = useCallback((transitionId: string) => {
    channelRef.current?.postMessage({
      type: "actor-transition-released",
      transitionId,
    });
  }, []);

  const clearLoginTransactionState = useCallback(() => {
    transactionRef.current = null;
    beginOperationRef.current = null;
    completionOperationRef.current = null;
    cancelOperationRef.current = null;
    transactionTargetSlotIdRef.current = null;
    setTransaction(null);
  }, []);

  const settleActorTransition = useCallback(
    async (
      kind: BrowserAccountTransitionKind,
      from: ManagedAuthSessionSetProjection | null,
      accepted: ManagedAuthSessionSetProjection | null,
      sequence: number,
      publish: boolean,
      authorityResetConfirmed = false,
      initiatingSurfaceFenced = false,
    ): Promise<ManagedAuthSessionSetProjection | null> => {
      let source = from;
      let target = accepted;
      if (!authorityResetConfirmed && from && target && isOlderProjection(target, from)) {
        target = await client.getSessionSet();
        if (sequenceRef.current !== sequence) return null;
        if (isOlderProjection(target, from)) {
          throw new Error("Browser account response regressed the accepted actor epoch");
        }
      }
      if (!initiatingSurfaceFenced && sameSelectedActor(source, target)) {
        setProjection(target);
        setPhase("ready");
        setError(null);
        return target;
      }
      while (true) {
        transitionAbortRef.current?.abort();
        const controller = new AbortController();
        transitionAbortRef.current = controller;
        // The accepted mutation is already server authority. Notify peers now,
        // before this tab waits for its own auth/access reload, so they can hide
        // and abort old-actor work throughout that entire window.
        if (publish) publishActorHint(target);
        setPhase("loading");
        await onActorTransition({
          kind,
          from: initiatingSurfaceFenced ? null : source,
          to: target,
          signal: controller.signal,
        });
        initiatingSurfaceFenced = false;
        if (controller.signal.aborted || sequenceRef.current !== sequence) return null;
        if (!target) {
          setProjection(null);
          setPhase("ready");
          setError(null);
          return null;
        }
        const confirmed = await client.reconcileSessionSetAuthority();
        if (controller.signal.aborted || sequenceRef.current !== sequence) return null;
        if (sameActor(target, confirmed) || sameSelectedActor(target, confirmed)) {
          setProjection(confirmed);
          setPhase("ready");
          setError(null);
          return confirmed;
        }
        // Tenant state was loaded for an authority that rotated again while
        // the host callback was pending. The explicit two-probe result is the
        // new authority even when its counters are lower, so keep the actor
        // hidden and settle that authority before exposing ready state.
        source = target;
        target = confirmed;
      }
    },
    [client, onActorTransition, publishActorHint],
  );

  const reconcile = useCallback(
    async (kind: BrowserAccountTransitionKind, publish = false) => {
      const sequence = ++sequenceRef.current;
      const before = projectionRef.current;
      setPhase("loading");
      let first = await client.reconcileSessionSetAuthority();
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
      if (sameActor(before, first) || sameSelectedActor(before, first)) {
        setProjection(first);
        setPhase("ready");
        setError(null);
        return first;
      }
      if (kind === "cross_tab") clearLoginTransactionState();
      return await settleActorTransition(kind, before, first, sequence, publish, true);
    },
    [bootstrapLegacySession, clearLoginTransactionState, client, settleActorTransition],
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
      const expectedGeneration = pending.expectedGeneration ?? current.generation;
      pending.expectedGeneration = expectedGeneration;
      const sequence = ++sequenceRef.current;
      pendingCommitSequenceRef.current = sequence;
      pendingServerMutationSequenceRef.current = null;
      invalidatedDuringPendingCommitRef.current = false;
      pendingRef.current = pending;
      setPhase("committing");
      setError(null);
      const changesActor = pending.changesActor(current);
      let initiatingActorFenced = false;
      try {
        if (changesActor) {
          // Every tab, including the initiator, must hide and abort the old actor
          // before this request can be accepted. Otherwise a response-lost
          // logout can leave the initiating route alive long enough for its
          // event stream to reconnect with the newly revoked cookie.
          publishActorHold(pending.operationId, current);
          transitionAbortRef.current?.abort();
          const controller = new AbortController();
          transitionAbortRef.current = controller;
          projectionRef.current = null;
          setProjection(null);
          setPhase("loading");
          // The host can synchronously clear its actor surface before its
          // transition promise later rejects. From this point on, every
          // failure must reconcile and restore authority even though the
          // account mutation has not started yet.
          initiatingActorFenced = true;
          await onActorTransition({
            kind: pending.kind,
            from: current,
            to: null,
            signal: controller.signal,
          });
          if (controller.signal.aborted || sequenceRef.current !== sequence) return false;
          // Yield one task after the secret-free hold so queued BroadcastChannel
          // delivery can fence peers before the network mutation starts.
          await yieldToCrossTabActorHold();
          if (controller.signal.aborted || sequenceRef.current !== sequence) return false;
        }
        pendingServerMutationSequenceRef.current = sequence;
        let accepted: ManagedAuthSessionSetProjection;
        try {
          accepted = await pending.execute(expectedGeneration);
        } catch (caught) {
          if (errorCode(caught) !== "operation_outcome_unknown") throw caught;
          // The command may already be durable. Replay exactly once before a
          // generic authority read so a response-lost terminal mutation can
          // recover its receipt with the frozen operation and admission data.
          accepted = await pending.execute(expectedGeneration);
        }
        if (sequenceRef.current !== sequence) return false;
        // A successful logout-all response is itself an authority-rotation
        // receipt; every other lower-clock adoption must come from the SDK's
        // explicit two-probe reconciliation path below.
        let authorityResetConfirmed = pending.kind === "logout_all";
        if (invalidatedDuringPendingCommitRef.current) {
          accepted = await client.reconcileSessionSetAuthority();
          authorityResetConfirmed = true;
          if (sequenceRef.current !== sequence) return false;
        }
        pendingRef.current = null;
        // The server response and any invalidation reconciliation are now
        // authoritative. Release commit ownership before host settlement so a
        // later invalidation starts its own reconciliation instead of relying
        // on the already-consumed check above.
        if (pendingServerMutationSequenceRef.current === sequence) {
          pendingServerMutationSequenceRef.current = null;
        }
        if (pendingCommitSequenceRef.current === sequence) {
          pendingCommitSequenceRef.current = null;
          invalidatedDuringPendingCommitRef.current = false;
        }
        if (
          !initiatingActorFenced &&
          !authorityResetConfirmed &&
          sameSelectedActor(current, accepted)
        ) {
          setProjection(accepted);
          setPhase("ready");
          setError(null);
        } else {
          await settleActorTransition(
            pending.kind,
            current,
            accepted,
            sequence,
            true,
            authorityResetConfirmed,
            initiatingActorFenced,
          );
        }
        return true;
      } catch (caught) {
        if (initiatingActorFenced) {
          let authorityRestored = false;
          try {
            const restored = await client.reconcileSessionSetAuthority();
            if (sequenceRef.current !== sequence) return false;
            await settleActorTransition(
              pending.kind,
              current,
              restored,
              sequence,
              false,
              true,
              true,
            );
            if (sequenceRef.current !== sequence) return false;
            authorityRestored = true;
          } catch {
            // If authority itself cannot be reconciled, retain the existing
            // fail-closed provider error path and its manual retry surface.
          }
          if (authorityRestored) {
            // Restore transport provenance before retaining the existing
            // fail-closed retry surface. The retry screen keeps tenant data
            // hidden, while refresh can safely reveal this reconciled actor.
            const restoredError = accountError(caught);
            setError(restoredError);
            setPhase("recoverable_error");
            throw restoredError;
          }
        }
        return await fail(caught, pending.kind);
      } finally {
        if (changesActor) publishActorRelease(pending.operationId);
        if (pendingServerMutationSequenceRef.current === sequence) {
          pendingServerMutationSequenceRef.current = null;
        }
        if (pendingCommitSequenceRef.current === sequence) {
          pendingCommitSequenceRef.current = null;
          invalidatedDuringPendingCommitRef.current = false;
        }
      }
    },
    [
      client,
      fail,
      inspectBlockers,
      onActorTransition,
      publishActorHold,
      publishActorRelease,
      settleActorTransition,
    ],
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

  const beginNeutralActorInvalidation = useCallback(
    async (before: ManagedAuthSessionSetProjection | null): Promise<AbortController> => {
      transitionAbortRef.current?.abort();
      const controller = new AbortController();
      transitionAbortRef.current = controller;
      projectionRef.current = null;
      setProjection(null);
      clearLoginTransactionState();
      setPhase("loading");
      setError(null);
      // Do not wait for the authority reread before asking the host to remove
      // and abort the prior actor. A response that was already in flight can
      // otherwise commit old tenant state during the cross-tab hint/read race.
      await onActorTransition({
        kind: "cross_tab",
        from: before,
        to: null,
        signal: controller.signal,
      });
      return controller;
    },
    [clearLoginTransactionState, onActorTransition],
  );

  const invalidateActor = useCallback(async () => {
    const pendingCommitSequence = pendingCommitSequenceRef.current;
    if (
      pendingCommitSequence !== null &&
      pendingServerMutationSequenceRef.current === pendingCommitSequence
    ) {
      invalidatedDuringPendingCommitRef.current = true;
      await beginNeutralActorInvalidation(projectionRef.current);
      return null;
    }
    // An authority hint that arrives while the initiating host fence is still
    // pending supersedes the not-yet-dispatched mutation. Reconcile it here;
    // otherwise aborting that fence makes executePending return early while no
    // operation remains to restore the neutral actor surface.
    if (pendingCommitSequence !== null) {
      pendingCommitSequenceRef.current = null;
      pendingServerMutationSequenceRef.current = null;
      invalidatedDuringPendingCommitRef.current = false;
      pendingRef.current = null;
    }
    const sequence = ++sequenceRef.current;
    const before = projectionRef.current;
    try {
      const neutral = await beginNeutralActorInvalidation(before);
      if (neutral.signal.aborted || sequenceRef.current !== sequence) return null;
      const accepted = await client.reconcileSessionSetAuthority();
      if (sequenceRef.current !== sequence) return null;
      return await settleActorTransition("cross_tab", before, accepted, sequence, false, true);
    } catch (caught) {
      if (sequenceRef.current !== sequence) return null;
      const nextError = accountError(caught);
      setError(nextError);
      setPhase("recoverable_error");
      throw nextError;
    }
  }, [beginNeutralActorInvalidation, client, settleActorTransition]);

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
      const sequence = ++sequenceRef.current;
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
      let next: ManagedAuthLoginTransaction;
      try {
        next = await client.beginLoginTransaction({
          operationId: beginOperation,
          expectedGeneration: current.generation,
          kind,
          ...(slotId ? { slotId } : {}),
          ...(returnIntent ? { returnIntent } : {}),
        });
      } catch (caught) {
        if (sequenceRef.current !== sequence) {
          if (beginOperationRef.current?.operationId === beginOperation) {
            beginOperationRef.current = null;
          }
          throw supersededOperationError();
        }
        return await fail(caught, kind);
      }
      if (sequenceRef.current !== sequence) {
        if (beginOperationRef.current?.operationId === beginOperation) {
          beginOperationRef.current = null;
        }
        throw supersededOperationError();
      }
      beginOperationRef.current = null;
      transactionTargetSlotIdRef.current = slotId ?? null;
      completionOperationRef.current = null;
      cancelOperationRef.current = null;
      setTransaction(next);
      setPhase("ready");
      return next;
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
      const completionOperation = completionOperationRef.current ?? {
        operationId: operationId(),
        expectedGeneration: current.generation,
      };
      completionOperationRef.current = completionOperation;
      try {
        const completed = await client.completeEmailPasswordTransaction({
          operationId: completionOperation.operationId,
          expectedGeneration: completionOperation.expectedGeneration,
          transactionId: activeTransaction.id,
          email: input.email,
          password: input.password,
        });
        if (sequenceRef.current !== sequence) return false;
        completionOperationRef.current = null;
        cancelOperationRef.current = null;
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
        return await fail(caught, activeTransaction.kind);
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
        completionOperationRef.current = null;
        cancelOperationRef.current = null;
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
    const sequence = ++sequenceRef.current;
    setPhase("committing");
    const cancelOperation = cancelOperationRef.current ?? {
      operationId: operationId(),
      expectedGeneration: current.generation,
    };
    cancelOperationRef.current = cancelOperation;
    let next: ManagedAuthSessionSetProjection;
    try {
      next = await client.cancelLoginTransaction({
        operationId: cancelOperation.operationId,
        expectedGeneration: cancelOperation.expectedGeneration,
        transactionId: activeTransaction.id,
      });
    } catch (caught) {
      if (sequenceRef.current !== sequence) {
        if (cancelOperationRef.current?.operationId === cancelOperation.operationId) {
          cancelOperationRef.current = null;
        }
        throw supersededOperationError();
      }
      await fail(caught, activeTransaction.kind);
      return;
    }
    if (sequenceRef.current !== sequence) {
      if (cancelOperationRef.current?.operationId === cancelOperation.operationId) {
        cancelOperationRef.current = null;
      }
      throw supersededOperationError();
    }
    clearLoginTransactionState();
    setProjection(next);
    setPhase("ready");
    setError(null);
  }, [clearLoginTransactionState, client, fail]);

  const selectSlot = useCallback(
    async (slotId: string) => {
      const id = operationId();
      return await executePending({
        kind: "select",
        operationId: id,
        expectedGeneration: null,
        changesActor: (current) => current.selectedSlotId !== slotId,
        execute: async (expectedGeneration) =>
          await client.selectLoginSlot({
            operationId: id,
            expectedGeneration,
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
        expectedGeneration: null,
        changesActor: (current) => current.selectedSlotId === slotId,
        execute: async (expectedGeneration) =>
          await client.logoutLoginSlot({
            operationId: id,
            expectedGeneration,
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
      expectedGeneration: null,
      // Logout-all always rotates the browser-set authority, even when the set
      // is neutral but still contains slots. Peers must therefore enter the
      // same precommit hold and reconciliation boundary unconditionally.
      changesActor: () => true,
      execute: async (expectedGeneration) => {
        await client.logoutSessionSet({ operationId: id, expectedGeneration });
        return await client.getSessionSet();
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
    const actorHolds = crossTabActorHoldsRef.current;
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== "object") return;
      const hint = value as {
        type?: unknown;
        transitionId?: unknown;
        actorEpoch?: unknown;
        generation?: unknown;
      };
      if (hint.type === "actor-transition-pending") {
        if (
          typeof hint.transitionId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            hint.transitionId,
          ) ||
          typeof hint.actorEpoch !== "string" ||
          typeof hint.generation !== "string" ||
          crossTabActorHoldsRef.current.has(hint.transitionId)
        ) {
          return;
        }
        const current = projectionRef.current;
        if (
          current &&
          (current.actorEpoch !== hint.actorEpoch || current.generation !== hint.generation)
        ) {
          return;
        }
        if (!current && crossTabActorHoldsRef.current.size === 0) return;
        const firstHold = crossTabActorHoldsRef.current.size === 0;
        const timeout = setTimeout(() => {
          if (!crossTabActorHoldsRef.current.delete(hint.transitionId as string)) return;
          if (crossTabActorHoldsRef.current.size === 0) {
            void invalidateActor().catch(() => undefined);
          }
        }, CROSS_TAB_ACTOR_HOLD_MS);
        crossTabActorHoldsRef.current.set(hint.transitionId, timeout);
        if (firstHold) {
          if (pendingCommitSequenceRef.current !== null) {
            invalidatedDuringPendingCommitRef.current = true;
          } else {
            ++sequenceRef.current;
          }
          void beginNeutralActorInvalidation(current).catch(() => undefined);
        }
        return;
      }
      if (hint.type === "actor-transition-released") {
        if (typeof hint.transitionId !== "string") return;
        const timeout = crossTabActorHoldsRef.current.get(hint.transitionId);
        if (timeout === undefined) return;
        clearTimeout(timeout);
        crossTabActorHoldsRef.current.delete(hint.transitionId);
        if (crossTabActorHoldsRef.current.size === 0) {
          void invalidateActor().catch(() => undefined);
        }
        return;
      }
      if (
        hint.type !== "actor-epoch-changed" ||
        typeof hint.actorEpoch !== "string" ||
        typeof hint.generation !== "string" ||
        (hint.actorEpoch === projectionRef.current?.actorEpoch &&
          hint.generation === projectionRef.current?.generation)
      ) {
        return;
      }
      for (const timeout of crossTabActorHoldsRef.current.values()) clearTimeout(timeout);
      crossTabActorHoldsRef.current.clear();
      void invalidateActor().catch(() => undefined);
    };
    return () => {
      for (const timeout of actorHolds.values()) clearTimeout(timeout);
      actorHolds.clear();
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [beginNeutralActorInvalidation, broadcastChannelName, invalidateActor]);

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
