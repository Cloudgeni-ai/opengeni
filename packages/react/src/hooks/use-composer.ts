import type {
  ComposerDraft,
  EffectiveControlResumeOption,
  EffectiveSessionControl,
  OpenGeniApiError,
  ResourceRef,
  SaveComposerDraftRequest,
  SendMessageInput,
  SessionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

export type ComposerSendExtras = Omit<SendMessageInput, "text" | "clientEventId">;

export type UseComposerOptions = EmbeddedSessionClientOverride &
  SessionEventFeedOptions & {
    /** Called with the exact accepted wire input after a successful send. */
    onSent?: ((text: string, input: SendMessageInput) => void) | undefined;
    /**
     * Extra message fields (resources, tools, model, reasoningEffort, latencyMode) merged
     * into every send. A function is evaluated at send time so it can read the
     * surrounding UI state (attachment pickers, model selectors, ...).
     */
    sendExtras?: ComposerSendExtras | (() => ComposerSendExtras) | undefined;
    /**
     * Fail-closed delivery guard evaluated at send time. Attachment hosts use
     * this to preserve unresolved upload cards until the operator waits,
     * retries, or removes them; direct hook callers cannot bypass the UI gate.
     */
    sendBlocked?: (() => boolean) | undefined;
    /** Latest server-derived workstream control; bound into Send/Steer OCC. */
    effectiveControl?: EffectiveSessionControl | null | undefined;
    /** Apply durable model/tool/reasoning settings in the host's controlled UI. */
    onDraftApplied?: ((draft: ComposerDraft) => void) | undefined;
    /** Disable remote composer-draft reads and writes for embedded hosts. */
    draftPersistence?: "durable" | "disabled" | undefined;
  };

type ComposerDraftShadow = {
  text: string;
  resources: ResourceRef[];
};

type PendingComposerOperation = {
  delivery: "send" | "steer";
  input: SendMessageInput;
  draftAtSend: string;
  resourcesAtSend: ResourceRef[];
  /** Latest local text/resources that must survive an uncertain delivery. */
  newerShadow: ComposerDraftShadow;
  clearDraftOnAccept: boolean;
  /** False after remount when the original input carried secret credentials. */
  canRetry: boolean;
};

type StoredPendingComposerOperation = Omit<PendingComposerOperation, "input" | "canRetry"> & {
  input: Omit<SendMessageInput, "mcpCredentialUpdates">;
  hasMcpCredentialUpdates: boolean;
};

const PENDING_COMPOSER_STORAGE_PREFIX = "opengeni.pending-composer.v1:";

// A remount must not manufacture a new operation while the previous mutation
// is still outcome-unknown. Keep only non-credential request fields here; the
// mounted hook retains the exact input, including any credential updates. The
// safe shadow is also session-scoped so a refresh cannot lose newer edits.
const pendingComposerOperations = new Map<string, StoredPendingComposerOperation>();

function pendingComposerOperationKey(
  workspaceId: string,
  sessionId: string | null | undefined,
): string | null {
  return sessionId ? `${workspaceId}\u0000${sessionId}` : null;
}

function pendingComposerStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function pendingComposerStorageKey(key: string): string {
  return `${PENDING_COMPOSER_STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function resourceList(value: unknown): value is ResourceRef[] {
  return (
    Array.isArray(value) &&
    value.every((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const resource = candidate as Record<string, unknown>;
      return resource.kind === "file"
        ? typeof resource.fileId === "string"
        : resource.kind === "repository" &&
            typeof resource.uri === "string" &&
            typeof resource.ref === "string";
    })
  );
}

function readStoredPendingComposerOperation(
  key: string | null,
): StoredPendingComposerOperation | null {
  const storage = key ? pendingComposerStorage() : null;
  if (!storage || !key) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(pendingComposerStorageKey(key)) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const input = record.input;
    const shadow = record.newerShadow;
    if (
      typeof input !== "object" ||
      input === null ||
      typeof shadow !== "object" ||
      shadow === null
    ) {
      return null;
    }
    const inputRecord = input as Record<string, unknown>;
    const shadowRecord = shadow as Record<string, unknown>;
    if (
      (record.delivery !== "send" && record.delivery !== "steer") ||
      typeof record.draftAtSend !== "string" ||
      !resourceList(record.resourcesAtSend) ||
      typeof shadowRecord.text !== "string" ||
      !resourceList(shadowRecord.resources) ||
      typeof record.clearDraftOnAccept !== "boolean" ||
      typeof record.hasMcpCredentialUpdates !== "boolean" ||
      typeof inputRecord.text !== "string" ||
      typeof inputRecord.clientEventId !== "string" ||
      "mcpCredentialUpdates" in inputRecord ||
      ("resources" in inputRecord && !resourceList(inputRecord.resources))
    ) {
      return null;
    }
    return record as StoredPendingComposerOperation;
  } catch {
    return null;
  }
}

function writePendingComposerOperation(
  key: string,
  operation: StoredPendingComposerOperation,
): void {
  const storage = pendingComposerStorage();
  if (!storage) return;
  try {
    storage.setItem(pendingComposerStorageKey(key), JSON.stringify(operation));
  } catch {
    // Storage is best effort; the in-memory record still protects remounts.
  }
}

function restorePendingComposerOperation(key: string | null): PendingComposerOperation | null {
  const stored =
    (key && pendingComposerOperations.get(key)) ?? readStoredPendingComposerOperation(key);
  if (!stored) return null;
  return {
    ...stored,
    input: stored.input,
    newerShadow: stored.newerShadow ?? {
      text: stored.draftAtSend,
      resources: stored.resourcesAtSend,
    },
    canRetry: !stored.hasMcpCredentialUpdates,
  };
}

function rememberPendingComposerOperation(
  key: string | null,
  operation: PendingComposerOperation,
): void {
  if (!key) return;
  const { canRetry: _retry, ...safeOperation } = operation;
  const { input: originalInput, ...withoutInput } = safeOperation;
  const { mcpCredentialUpdates: _storedMcp, ...safeInput } = originalInput;
  const stored = {
    ...withoutInput,
    input: safeInput,
    hasMcpCredentialUpdates: operation.input.mcpCredentialUpdates !== undefined,
    newerShadow: {
      text: operation.newerShadow.text,
      resources: [...operation.newerShadow.resources],
    },
  } satisfies StoredPendingComposerOperation;
  pendingComposerOperations.set(key, stored);
  writePendingComposerOperation(key, stored);
}

function forgetPendingComposerOperation(key: string | null): void {
  if (!key) return;
  pendingComposerOperations.delete(key);
  const storage = pendingComposerStorage();
  if (!storage) return;
  try {
    storage.removeItem(pendingComposerStorageKey(key));
  } catch {
    // Ignore a blocked storage implementation; delivery has already settled.
  }
}

function updatePendingComposerShadow(
  key: string | null,
  operation: PendingComposerOperation | null,
  shadow: ComposerDraftShadow,
): PendingComposerOperation | null {
  if (!key || !operation) return operation;
  const next = { ...operation, newerShadow: { ...shadow, resources: [...shadow.resources] } };
  rememberPendingComposerOperation(key, next);
  return next;
}

export type ComposerState = {
  value: string;
  setValue: (value: string) => void;
  /** Read the current draft synchronously before a destructive replacement. */
  hasDraftContent: () => boolean;
  /** Append the draft behind prompts already visible in the queue. */
  send: (text?: string) => Promise<boolean>;
  /** Supersede current direction with the draft. */
  steer: (text?: string) => Promise<boolean>;
  /** Optimistic-to-durable projection for a Steer that has not started yet. */
  steering?: ComposerSteeringState | null | undefined;
  sending: boolean;
  canSend: boolean;
  /** Pause the session without deleting its prompt queue. */
  pause: (reason?: string) => Promise<void>;
  pausing: boolean;
  resume: (reason?: string) => Promise<void>;
  resumeScope: (option: EffectiveControlResumeOption) => Promise<void>;
  resuming: boolean;
  draft: ComposerDraft | null;
  draftRevision: number;
  draftLoading: boolean;
  draftSaving: boolean;
  draftConflict: Error | null;
  /** Whether this controller owns a durable server-side draft. */
  draftPersistence?: "durable" | "disabled" | undefined;
  /** Apply an atomic queue Edit checkout without a second read. */
  applyDraft: (draft: ComposerDraft) => void;
  reloadDraft: () => Promise<void>;
  resolveDraftConflict: (choice: "keep_mine" | "use_remote") => Promise<void>;
  restoredResources: ResourceRef[];
  removeRestoredResource: (index: number) => void;
  error: Error | null;
  clearError: () => void;
};

export type ComposerSteeringState = {
  phase: "submitting" | "accepted";
  text: string;
  clientEventId: string | null;
  triggerEventId: string | null;
  turnId: string | null;
};

const STEERING_SETTLEMENT_EVENT_TYPES = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

function isSteeringSettlementEvent(event: SessionEvent): boolean {
  return STEERING_SETTLEMENT_EVENT_TYPES.has(event.type);
}

function steeringSettledByEvents(
  steering: ComposerSteeringState,
  events: readonly SessionEvent[],
): boolean {
  const acceptedEventId =
    steering.triggerEventId ??
    events.find(
      (event) =>
        event.type === "user.message" &&
        steering.clientEventId !== null &&
        event.clientEventId === steering.clientEventId,
    )?.id ??
    null;
  return events.some((event) => {
    if (steering.turnId && event.turnId === steering.turnId && isSteeringSettlementEvent(event)) {
      return true;
    }
    if (event.type !== "turn.started" || !acceptedEventId) return false;
    const payload = event.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "triggerEventId" in payload &&
      payload.triggerEventId === acceptedEventId
    );
  });
}

/**
 * Draft + send + Pause/Resume state for the chat composer — the only
 * human-to-agent input surface. The draft survives a failed send (nothing is
 * more hostile than losing a typed message); each send carries a generated
 * `clientEventId` so retries stay idempotent server-side.
 */
export function useComposer(
  sessionId: string | null | undefined,
  options: UseComposerOptions = {},
): ComposerState {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedSession(options);
  const durableDrafts = options.draftPersistence !== "disabled";
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${durableDrafts ? "durable" : "disabled"}`;
  const pendingOperationKey = pendingComposerOperationKey(workspaceId, sessionId);
  const initialPendingOperation = restorePendingComposerOperation(pendingOperationKey);
  const initialShadow = initialPendingOperation?.newerShadow;
  const [value, setValue] = useState(() => initialShadow?.text ?? "");
  // Keep rendered state behind the committed target identity for one frame:
  // a parent may switch sessionId without remounting this public hook.
  const [stateTargetKey, setStateTargetKey] = useState(targetKey);
  const [sending, setSending] = useState(false);
  const [steering, setSteering] = useState<ComposerSteeringState | null>(() =>
    initialPendingOperation?.delivery === "steer"
      ? {
          phase: "submitting",
          text: initialPendingOperation.input.text,
          clientEventId: initialPendingOperation.input.clientEventId ?? null,
          triggerEventId: null,
          turnId: null,
        }
      : null,
  );
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(Boolean(sessionId) && durableDrafts);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftConflict, setDraftConflict] = useState<Error | null>(null);
  const [restoredResources, setRestoredResources] = useState<ResourceRef[]>(
    () => initialShadow?.resources ?? [],
  );
  const pendingOperationRef = useRef<PendingComposerOperation | null>(initialPendingOperation);
  const steeringSettlementEventsRef = useRef<SessionEvent[]>([]);
  const pendingClientEventId = useRef<string | null>(
    initialPendingOperation?.input.clientEventId ?? null,
  );
  const valueRef = useRef(initialShadow?.text ?? "");
  const draftRef = useRef<ComposerDraft | null>(null);
  const restoredResourcesRef = useRef<ResourceRef[]>(initialShadow?.resources ?? []);
  const localEditRevision = useRef(initialShadow ? 1 : 0);
  const targetGeneration = useRef(0);
  const draftReadGeneration = useRef(0);
  const lastSavedSignature = useRef<string | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const onSent = options.onSent;
  const onDraftApplied = options.onDraftApplied;
  // Read through a ref so live session/policy projections can replace their
  // apply callback without invalidating the draft loader and re-running its
  // initial-load effect. Publish only committed callbacks: a suspended target
  // render must not retarget an in-flight read owned by the committed session.
  const onDraftAppliedRef = useRef(onDraftApplied);
  useLayoutEffect(() => {
    onDraftAppliedRef.current = onDraftApplied;
  }, [onDraftApplied]);
  // Read through a ref so a new extras closure (created every render by
  // callers passing inline functions) does not invalidate `send`.
  const sendExtrasRef = useRef(options.sendExtras);
  sendExtrasRef.current = options.sendExtras;
  const sendBlockedRef = useRef(options.sendBlocked);
  sendBlockedRef.current = options.sendBlocked;
  const liveExtrasVersion = JSON.stringify(resolveSendExtras(options.sendExtras));

  // A composer is bound to one session: switching targets must not leak the
  // previous session's draft, error, or retry idempotency key.
  const targetKeyRef = useRef(targetKey);
  useLayoutEffect(() => {
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    targetGeneration.current += 1;
    draftReadGeneration.current += 1;
    pendingOperationRef.current = restorePendingComposerOperation(pendingOperationKey);
    steeringSettlementEventsRef.current = [];
    pendingClientEventId.current = pendingOperationRef.current?.input.clientEventId ?? null;
    const shadow = pendingOperationRef.current?.newerShadow;
    localEditRevision.current = shadow ? 1 : 0;
    valueRef.current = shadow?.text ?? "";
    draftRef.current = null;
    restoredResourcesRef.current = shadow?.resources ?? [];
    lastSavedSignature.current = null;
    // Old saves may still be awaiting the network. Their generation fence
    // prevents settlement, and a fresh chain avoids blocking this target.
    saveChain.current = Promise.resolve();
    setStateTargetKey(targetKey);
    setValue(shadow?.text ?? "");
    setSending(false);
    setSteering(
      pendingOperationRef.current?.delivery === "steer"
        ? {
            phase: "submitting",
            text: pendingOperationRef.current.input.text,
            clientEventId: pendingOperationRef.current.input.clientEventId ?? null,
            triggerEventId: null,
            turnId: null,
          }
        : null,
    );
    setPausing(false);
    setResuming(false);
    setError(null);
    setDraft(null);
    setDraftLoading(Boolean(sessionId) && durableDrafts);
    setDraftSaving(false);
    setDraftConflict(null);
    setRestoredResources(shadow?.resources ?? []);
  }, [durableDrafts, pendingOperationKey, sessionId, targetKey]);

  const applyDraft = useCallback(
    (next: ComposerDraft): void => {
      if (targetKeyRef.current !== targetKey) return;
      if (!durableDrafts) {
        localEditRevision.current += 1;
        valueRef.current = next.text;
        restoredResourcesRef.current = next.resources;
        draftRef.current = null;
        lastSavedSignature.current = null;
        setDraft(null);
        setValue(next.text);
        setRestoredResources(next.resources);
        pendingOperationRef.current = updatePendingComposerShadow(
          pendingOperationKey,
          pendingOperationRef.current,
          {
            text: next.text,
            resources: mergeResources(
              next.resources,
              resolveSendExtras(sendExtrasRef.current).resources ?? [],
            ),
          },
        );
        setDraftConflict(null);
        return;
      }
      valueRef.current = next.text;
      draftRef.current = next;
      restoredResourcesRef.current = next.resources;
      lastSavedSignature.current = draftSignature(draftPayload(next));
      localEditRevision.current += 1;
      setDraft(next);
      setValue(next.text);
      setRestoredResources(next.resources);
      pendingOperationRef.current = updatePendingComposerShadow(
        pendingOperationKey,
        pendingOperationRef.current,
        {
          text: next.text,
          resources: mergeResources(
            next.resources,
            resolveSendExtras(sendExtrasRef.current).resources ?? [],
          ),
        },
      );
      setDraftConflict(null);
      onDraftAppliedRef.current?.(next);
    },
    [durableDrafts, pendingOperationKey, targetKey],
  );

  const loadDraft = useCallback(
    async (replaceLocal: boolean): Promise<void> => {
      if (targetKeyRef.current !== targetKey) return;
      if (!sessionId || !durableDrafts) {
        setDraftLoading(false);
        return;
      }
      const generation = targetGeneration.current;
      const readTicket = ++draftReadGeneration.current;
      const localAtStart = localEditRevision.current;
      const baseAtStart = draftRef.current;
      const extrasAtStart = resolveSendExtras(sendExtrasRef.current);
      const localSignatureAtStart = baseAtStart
        ? draftSignature(
            composerDraftPayload(
              baseAtStart,
              valueRef.current,
              restoredResourcesRef.current,
              extrasAtStart,
            ),
          )
        : null;
      const localWasDirtyAtStart =
        localSignatureAtStart === null
          ? localAtStart !== 0
          : localSignatureAtStart !== lastSavedSignature.current;
      // Only blank the picker on first hydrate / hard reload. Reconcile and
      // event-triggered soft reloads (loadOlder SSE reconnect) must not flicker
      // draftLoading — stale-while-revalidate keeps the settled UI mounted.
      const showLoading = replaceLocal || draftRef.current === null;
      if (showLoading) {
        setDraftLoading(true);
      }
      try {
        const fetched = await client.getComposerDraft(workspaceId, sessionId);
        if (
          generation !== targetGeneration.current ||
          targetKeyRef.current !== targetKey ||
          readTicket !== draftReadGeneration.current
        ) {
          return;
        }
        const currentRevision = draftRef.current?.revision ?? -1;
        if (fetched.revision >= currentRevision) {
          draftRef.current = fetched;
          setDraft(fetched);
          setDraftConflict(null);
          const shadow = pendingOperationRef.current?.newerShadow;
          if (shadow) {
            // The server can only know the original operation. Never replace
            // newer local edits while that operation is still uncertain.
            valueRef.current = shadow.text;
            restoredResourcesRef.current = shadow.resources;
            localEditRevision.current ||= 1;
            setValue(shadow.text);
            setRestoredResources(shadow.resources);
          } else if (
            replaceLocal ||
            (!localWasDirtyAtStart && localAtStart === localEditRevision.current)
          ) {
            // Model/effort ride in sendExtras (outside localEditRevision). If
            // the picker changed during this fetch, skip onDraftApplied so a
            // stale server model/effort cannot undo the operator's pick.
            const extrasNow = resolveSendExtras(sendExtrasRef.current);
            const pickerChangedDuringFetch =
              extrasNow.model !== extrasAtStart.model ||
              extrasNow.reasoningEffort !== extrasAtStart.reasoningEffort;
            valueRef.current = fetched.text;
            restoredResourcesRef.current = fetched.resources;
            lastSavedSignature.current = draftSignature(draftPayload(fetched));
            setValue(fetched.text);
            setRestoredResources(fetched.resources);
            if (replaceLocal || !pickerChangedDuringFetch) {
              onDraftAppliedRef.current?.(fetched);
            }
          }
        }
      } catch (cause) {
        if (
          generation === targetGeneration.current &&
          targetKeyRef.current === targetKey &&
          readTicket === draftReadGeneration.current
        ) {
          setError(asError(cause));
        }
      } finally {
        if (
          generation === targetGeneration.current &&
          targetKeyRef.current === targetKey &&
          readTicket === draftReadGeneration.current
        ) {
          setDraftLoading(false);
        }
      }
    },
    [client, durableDrafts, sessionId, targetKey, workspaceId],
  );

  useEffect(() => {
    if (!sessionId || !durableDrafts) {
      setDraftLoading(false);
      return;
    }
    void loadDraft(false);
  }, [durableDrafts, loadDraft, sessionId]);
  useEffect(() => {
    if (!sessionId || !durableDrafts) return;
    return registerSessionReconciler(sessionId, "composer", async () => await loadDraft(false));
  }, [durableDrafts, loadDraft, registerSessionReconciler, sessionId]);
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    (event) => isComposerDraftEvent(event) || isSteeringSettlementEvent(event),
    (event) => {
      if (isComposerDraftEvent(event)) void loadDraft(false);
      if (!isSteeringSettlementEvent(event)) return;
      steeringSettlementEventsRef.current = [
        ...steeringSettlementEventsRef.current.slice(-15),
        event,
      ];
      setSteering((current) => {
        if (!current || !steeringSettledByEvents(current, [event])) return current;
        steeringSettlementEventsRef.current = [];
        return null;
      });
    },
    {
      enabled: Boolean(sessionId) && (durableDrafts || steering !== null),
      ...(options.events !== undefined ? { events: options.events } : {}),
    },
  );

  useEffect(() => {
    if (!steering) return;
    const observed = [...(options.events ?? []), ...steeringSettlementEventsRef.current];
    if (!steeringSettledByEvents(steering, observed)) return;
    steeringSettlementEventsRef.current = [];
    setSteering(null);
  }, [options.events, steering]);

  const currentDraftPayload = useCallback((): SaveComposerDraftRequest | null => {
    if (!durableDrafts || targetKeyRef.current !== targetKey) return null;
    const base = draftRef.current;
    if (!base) return null;
    const extras = resolveSendExtras(sendExtrasRef.current);
    return composerDraftPayload(base, value, restoredResources, extras);
  }, [durableDrafts, restoredResources, targetKey, value]);

  const persistPayload = useCallback(
    async (payload: SaveComposerDraftRequest): Promise<boolean> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      if (!sessionId || !durableDrafts || targetKeyRef.current !== ownedTargetKey) {
        return false;
      }
      let success = false;
      const run = async () => {
        if (
          targetKeyRef.current !== ownedTargetKey ||
          targetGeneration.current !== ownedGeneration
        ) {
          return;
        }
        const current = draftRef.current;
        if (!current) return;
        const request = { ...payload, expectedRevision: current.revision };
        const signature = draftSignature(request);
        if (signature === lastSavedSignature.current) {
          success = true;
          return;
        }
        setDraftSaving(true);
        try {
          const saved = await client.saveComposerDraft(workspaceId, sessionId, request);
          if (
            targetKeyRef.current !== ownedTargetKey ||
            targetGeneration.current !== ownedGeneration
          ) {
            return;
          }
          draftRef.current = saved;
          setDraft(saved);
          lastSavedSignature.current = signature;
          setDraftConflict(null);
          success = true;
        } catch (cause) {
          if (
            targetKeyRef.current === ownedTargetKey &&
            targetGeneration.current === ownedGeneration
          ) {
            const problem = asError(cause);
            if (isDraftConflictError(problem)) setDraftConflict(problem);
            setError(problem);
          }
        } finally {
          if (
            targetKeyRef.current === ownedTargetKey &&
            targetGeneration.current === ownedGeneration
          ) {
            setDraftSaving(false);
          }
        }
      };
      saveChain.current = saveChain.current.then(run, run);
      await saveChain.current;
      return success;
    },
    [client, durableDrafts, sessionId, targetKey, workspaceId],
  );

  // Private durable autosave. A newer local edit is never replaced by an older
  // response; saves serialize and each reads the latest acknowledged revision.
  useEffect(() => {
    const pending = pendingOperationRef.current;
    if (pending) {
      const shadow = {
        text: valueRef.current,
        resources: mergeResources(
          restoredResourcesRef.current,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
      };
      if (
        pending.newerShadow.text !== shadow.text ||
        JSON.stringify(pending.newerShadow.resources) !== JSON.stringify(shadow.resources)
      ) {
        pendingOperationRef.current = updatePendingComposerShadow(
          pendingOperationKey,
          pending,
          shadow,
        );
      }
      return;
    }
    if (
      !durableDrafts ||
      !sessionId ||
      draftLoading ||
      sending ||
      !draftRef.current ||
      draftConflict
    )
      return;
    const payload = currentDraftPayload();
    if (!payload || draftSignature(payload) === lastSavedSignature.current) return;
    const timer = window.setTimeout(() => void persistPayload(payload), 500);
    return () => window.clearTimeout(timer);
  }, [
    currentDraftPayload,
    durableDrafts,
    draftConflict,
    draftLoading,
    liveExtrasVersion,
    pendingOperationKey,
    persistPayload,
    sending,
    sessionId,
  ]);

  const dispatch = useCallback(
    async (delivery: "send" | "steer", explicit?: string): Promise<boolean> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      const operationKey = pendingComposerOperationKey(workspaceId, sessionId);
      const pending = pendingOperationRef.current ?? restorePendingComposerOperation(operationKey);
      if (pending && !pendingOperationRef.current) {
        pendingOperationRef.current = pending;
        pendingClientEventId.current = pending.input.clientEventId ?? null;
      }
      const draftAtSend = value;
      const rawText = explicit ?? draftAtSend;
      const hasText = rawText.trim().length > 0;
      // Resolve the extras once: a file-only message (empty text + ≥1 ready
      // resource) is legitimate, so we must not bail on empty text alone.
      const extras = pending ? {} : resolveSendExtras(sendExtrasRef.current);
      const hasResources = restoredResources.length > 0 || (extras.resources?.length ?? 0) > 0;
      if (
        (!pending && !hasText && !hasResources) ||
        !sessionId ||
        sending ||
        sendBlockedRef.current?.() === true ||
        targetKeyRef.current !== ownedTargetKey
      ) {
        return false;
      }

      const clearPending = (): void => {
        pendingOperationRef.current = null;
        pendingClientEventId.current = null;
        forgetPendingComposerOperation(operationKey);
      };

      let keepSteering = pending?.delivery === "steer";

      const settleAccepted = (operation: PendingComposerOperation): void => {
        clearPending();
        const draftWasUnchanged = valueRef.current === operation.draftAtSend;
        const resourcesWereUnchanged =
          JSON.stringify(restoredResourcesRef.current) ===
          JSON.stringify(operation.resourcesAtSend);
        const previousDraft = draftRef.current;
        if (previousDraft) {
          const cleared = {
            ...previousDraft,
            revision: 0,
            text: "",
            resources: [],
            sourceTurnId: null,
            sourceTurnVersion: null,
            updatedAt: null,
          };
          draftRef.current = cleared;
          setDraft(cleared);
          lastSavedSignature.current = draftSignature(draftPayload(cleared));
        }
        if (resourcesWereUnchanged) {
          restoredResourcesRef.current = [];
          setRestoredResources([]);
        }
        if (operation.clearDraftOnAccept && draftWasUnchanged) {
          valueRef.current = "";
          setValue("");
        }
        onSent?.(operation.input.text, operation.input);
      };

      const deliver = async (operation: PendingComposerOperation) => {
        if (operation.delivery === "steer") {
          return await client.steerMessage(workspaceId, sessionId, operation.input);
        }
        await client.sendMessage(workspaceId, sessionId, operation.input);
        return null;
      };

      if (delivery === "steer") {
        setSteering({
          phase: "submitting",
          text: rawText,
          clientEventId: pending?.input.clientEventId ?? pendingClientEventId.current,
          triggerEventId: null,
          turnId: null,
        });
      }
      setSending(true);
      setError(null);
      try {
        if (pending) {
          let acceptedEvent: SessionEvent | null = null;
          try {
            const events = await client.listEvents(workspaceId, sessionId, {
              includeTypes: ["user.message"],
              limit: 100,
              payloadMode: "none",
            });
            acceptedEvent =
              events.find(
                (event) =>
                  event.type === "user.message" &&
                  event.clientEventId === pending.input.clientEventId,
              ) ?? null;
          } catch (cause) {
            if (
              targetKeyRef.current === ownedTargetKey &&
              targetGeneration.current === ownedGeneration
            ) {
              setError(asError(cause));
            }
            return false;
          }
          if (
            targetKeyRef.current !== ownedTargetKey ||
            targetGeneration.current !== ownedGeneration
          ) {
            return false;
          }
          if (acceptedEvent) {
            if (pending.delivery === "steer") {
              keepSteering = true;
              setSteering({
                phase: "accepted",
                text: pending.input.text,
                clientEventId: pending.input.clientEventId ?? null,
                triggerEventId: acceptedEvent.id,
                turnId: null,
              });
            }
            settleAccepted(pending);
            return true;
          }
          if (!pending.canRetry) {
            setError(
              new Error(
                "OpenGeni cannot safely retry this uncertain request after remount; reconcile the session before sending again.",
              ),
            );
            return false;
          }
          try {
            const result = await deliver(pending);
            if (pending.delivery === "steer" && result) {
              keepSteering = true;
              setSteering({
                phase: "accepted",
                text: pending.input.text,
                clientEventId: pending.input.clientEventId ?? null,
                triggerEventId: result.accepted.id,
                turnId: result.turn.id,
              });
            }
          } catch (cause) {
            if (pending.delivery === "steer") keepSteering = true;
            if (
              targetKeyRef.current === ownedTargetKey &&
              targetGeneration.current === ownedGeneration
            ) {
              setError(asError(cause));
            }
            return false;
          }
          if (
            targetKeyRef.current !== ownedTargetKey ||
            targetGeneration.current !== ownedGeneration
          ) {
            return false;
          }
          settleAccepted(pending);
          return true;
        }

        // Trimming is only an emptiness check. A non-blank prompt is persisted
        // and submitted byte-for-byte, while file-only sends use the same
        // placeholder for both operations so the server content fence cannot
        // reject its own client.
        const sendText = hasText ? rawText : FILE_ONLY_MESSAGE_TEXT;
        const currentPayload = currentDraftPayload();
        const payload = currentPayload ? { ...currentPayload, text: sendText } : null;
        if (payload && !(await persistPayload(payload))) return false;
        if (
          targetKeyRef.current !== ownedTargetKey ||
          targetGeneration.current !== ownedGeneration
        ) {
          return false;
        }
        // The wire contract requires non-empty text (z.string().min(1)) and the
        // worker rejects whitespace-only text; a file-only message therefore
        // carries a minimal default so the attachments still get delivered.
        pendingClientEventId.current ??= generateClientEventId();
        const input = composeSendInput(sendText, pendingClientEventId.current, extras, {
          ...(options.effectiveControl?.controlEtag
            ? { controlEtag: options.effectiveControl.controlEtag }
            : {}),
          ...(durableDrafts && draftRef.current
            ? { expectedDraftRevision: draftRef.current.revision }
            : {}),
          resources: mergeResources(restoredResources, extras.resources ?? []),
        });
        const operation: PendingComposerOperation = {
          delivery,
          input,
          draftAtSend,
          resourcesAtSend: [...restoredResources],
          newerShadow: {
            text: draftAtSend,
            resources: mergeResources(restoredResources, extras.resources ?? []),
          },
          clearDraftOnAccept: explicit === undefined,
          canRetry: true,
        };
        pendingOperationRef.current = operation;
        rememberPendingComposerOperation(operationKey, operation);
        if (delivery === "steer") {
          setSteering({
            phase: "submitting",
            text: sendText,
            clientEventId: input.clientEventId ?? null,
            triggerEventId: null,
            turnId: null,
          });
        }
        try {
          const result = await deliver(operation);
          if (delivery === "steer" && result) {
            keepSteering = true;
            setSteering({
              phase: "accepted",
              text: sendText,
              clientEventId: input.clientEventId ?? null,
              triggerEventId: result.accepted.id,
              turnId: result.turn.id,
            });
          }
        } catch (cause) {
          if (!isOutcomeUnknownError(cause)) {
            clearPending();
          } else if (delivery === "steer") {
            keepSteering = true;
          }
          if (
            targetKeyRef.current === ownedTargetKey &&
            targetGeneration.current === ownedGeneration
          ) {
            setError(asError(cause));
          }
          return false;
        }
        if (
          targetKeyRef.current !== ownedTargetKey ||
          targetGeneration.current !== ownedGeneration
        ) {
          return false;
        }
        settleAccepted(operation);
        return true;
      } finally {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setSending(false);
          if (delivery === "steer" && !keepSteering) setSteering(null);
        }
      }
    },
    [
      client,
      currentDraftPayload,
      durableDrafts,
      onSent,
      options.effectiveControl?.controlEtag,
      persistPayload,
      restoredResources,
      sending,
      sessionId,
      targetKey,
      value,
      workspaceId,
    ],
  );

  const send = useCallback(async (text?: string) => await dispatch("send", text), [dispatch]);
  const steer = useCallback(async (text?: string) => await dispatch("steer", text), [dispatch]);

  // A send is possible with non-empty text OR with ≥1 attached resource (a
  // file-only message). Resources ride in `sendExtras`, so we resolve them here
  // — keeping useComposer attachment-agnostic while still lighting up the send
  // affordance the moment a file is ready. Attachment hosts bind `sendBlocked`
  // to unresolved uploads so direct send()/steer() calls fail closed too.
  const hasReadyResources =
    restoredResources.length > 0 ||
    (resolveSendExtras(sendExtrasRef.current).resources?.length ?? 0) > 0;
  const hasPendingOperation = pendingOperationRef.current !== null;

  const pause = useCallback(
    async (reason?: string): Promise<void> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      if (!sessionId || pausing || targetKeyRef.current !== ownedTargetKey) {
        return;
      }
      setPausing(true);
      setError(null);
      try {
        await client.pauseSession(workspaceId, sessionId, {
          ...(reason !== undefined ? { reason } : {}),
          ...(options.effectiveControl?.controlEtag
            ? { expectedControlEtag: options.effectiveControl.controlEtag }
            : {}),
        });
      } catch (cause) {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      } finally {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setPausing(false);
        }
      }
    },
    [client, workspaceId, sessionId, pausing, options.effectiveControl?.controlEtag, targetKey],
  );

  const resume = useCallback(
    async (reason?: string): Promise<void> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      if (!sessionId || resuming || targetKeyRef.current !== ownedTargetKey) return;
      setResuming(true);
      setError(null);
      try {
        await client.resumeSession(workspaceId, sessionId, {
          ...(reason !== undefined ? { reason } : {}),
          ...(options.effectiveControl?.controlEtag
            ? { expectedControlEtag: options.effectiveControl.controlEtag }
            : {}),
        });
      } catch (cause) {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      } finally {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setResuming(false);
        }
      }
    },
    [client, workspaceId, sessionId, resuming, options.effectiveControl?.controlEtag, targetKey],
  );

  const resumeScope = useCallback(
    async (option: EffectiveControlResumeOption): Promise<void> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      if (!sessionId || resuming || targetKeyRef.current !== ownedTargetKey) return;
      setResuming(true);
      setError(null);
      try {
        if (option.scope === "workspace") {
          const workspaceBlocker = options.effectiveControl?.blockers.find(
            (blocker) => blocker.kind === "workspace",
          );
          if (!client.setWorkspaceInferenceState) {
            throw new Error(
              "@opengeni/react: workspace-scoped resume requires setWorkspaceInferenceState.",
            );
          }
          await client.setWorkspaceInferenceState(workspaceId, {
            action: "resume",
            clientEventId: generateClientEventId(),
            ...(workspaceBlocker ? { expectedRevision: workspaceBlocker.revision } : {}),
          });
        } else if (option.scope === "session" && option.targetId) {
          const target = await client.getQueue(workspaceId, option.targetId);
          if (
            targetKeyRef.current !== ownedTargetKey ||
            targetGeneration.current !== ownedGeneration
          ) {
            return;
          }
          await client.resumeSession(workspaceId, option.targetId, {
            expectedControlEtag: target.effectiveControl.controlEtag,
          });
        } else {
          await client.resumeSession(workspaceId, sessionId, {
            ...(options.effectiveControl?.controlEtag
              ? { expectedControlEtag: options.effectiveControl.controlEtag }
              : {}),
          });
        }
      } catch (cause) {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setError(asError(cause));
        }
      } finally {
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setResuming(false);
        }
      }
    },
    [client, options.effectiveControl, resuming, sessionId, targetKey, workspaceId],
  );

  const updateValue = useCallback(
    (next: string) => {
      if (targetKeyRef.current !== targetKey) return;
      localEditRevision.current += 1;
      valueRef.current = next;
      pendingOperationRef.current = updatePendingComposerShadow(
        pendingOperationKey,
        pendingOperationRef.current,
        {
          text: next,
          resources: mergeResources(
            restoredResourcesRef.current,
            resolveSendExtras(sendExtrasRef.current).resources ?? [],
          ),
        },
      );
      setValue(next);
    },
    [pendingOperationKey, targetKey],
  );

  const removeRestoredResource = useCallback(
    (index: number) => {
      if (targetKeyRef.current !== targetKey) return;
      localEditRevision.current += 1;
      const next = restoredResourcesRef.current.filter((_, candidate) => candidate !== index);
      restoredResourcesRef.current = next;
      pendingOperationRef.current = updatePendingComposerShadow(
        pendingOperationKey,
        pendingOperationRef.current,
        {
          text: valueRef.current,
          resources: mergeResources(next, resolveSendExtras(sendExtrasRef.current).resources ?? []),
        },
      );
      setRestoredResources(next);
    },
    [pendingOperationKey, targetKey],
  );

  const hasDraftContent = useCallback((): boolean => {
    const current = draftRef.current;
    const extras = resolveSendExtras(sendExtrasRef.current);
    return (
      valueRef.current.length > 0 ||
      restoredResourcesRef.current.length > 0 ||
      (extras.resources?.length ?? 0) > 0 ||
      (current?.sourceTurnId !== null && current?.sourceTurnId !== undefined)
    );
  }, []);

  const resolveDraftConflict = useCallback(
    async (choice: "keep_mine" | "use_remote"): Promise<void> => {
      const ownedTargetKey = targetKey;
      const ownedGeneration = targetGeneration.current;
      if (!sessionId || !durableDrafts || targetKeyRef.current !== ownedTargetKey) return;
      const remote = await client.getComposerDraft(workspaceId, sessionId);
      if (targetKeyRef.current !== ownedTargetKey || targetGeneration.current !== ownedGeneration) {
        return;
      }
      if (choice === "use_remote") {
        applyDraft(remote);
        return;
      }
      draftRef.current = remote;
      setDraft(remote);
      setDraftConflict(null);
      const payload = currentDraftPayload();
      if (payload) await persistPayload({ ...payload, expectedRevision: remote.revision });
    },
    [
      applyDraft,
      client,
      currentDraftPayload,
      durableDrafts,
      persistPayload,
      sessionId,
      targetKey,
      workspaceId,
    ],
  );

  const identityMatches = stateTargetKey === targetKey;
  const reloadDraft = useCallback(async () => await loadDraft(true), [loadDraft]);
  const clearError = useCallback(() => {
    if (targetKeyRef.current !== targetKey) return;
    setError(null);
    setDraftConflict(null);
  }, [targetKey]);

  return {
    value: identityMatches ? value : "",
    setValue: updateValue,
    hasDraftContent,
    send,
    steer,
    steering: identityMatches ? steering : null,
    sending: identityMatches ? sending : false,
    canSend:
      identityMatches &&
      Boolean(sessionId) &&
      !sending &&
      sendBlockedRef.current?.() !== true &&
      (hasPendingOperation || value.trim().length > 0 || hasReadyResources),
    pause,
    pausing: identityMatches ? pausing : false,
    resume,
    resumeScope,
    resuming: identityMatches ? resuming : false,
    draft: identityMatches ? draft : null,
    draftRevision: identityMatches ? (draft?.revision ?? 0) : 0,
    draftLoading: identityMatches ? draftLoading : Boolean(sessionId) && durableDrafts,
    draftSaving: identityMatches ? draftSaving : false,
    draftConflict: identityMatches ? draftConflict : null,
    draftPersistence: durableDrafts ? "durable" : "disabled",
    applyDraft,
    reloadDraft,
    resolveDraftConflict,
    restoredResources: identityMatches ? restoredResources : [],
    removeRestoredResource,
    error: identityMatches ? error : null,
    clearError,
  };
}

/** Events that can atomically replace or clear this subject's durable draft. */
export function isComposerDraftEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type === "user.message" || event.type === "session.queue.changed";
}

/**
 * Default text for a file-only message (attachment(s) present, no typed draft).
 * Kept non-empty so the wire contract (`text: z.string().min(1)`) and the
 * worker's non-whitespace guard accept it; the attached files still ride in
 * `resources`. Exported for tests.
 */
export const FILE_ONLY_MESSAGE_TEXT = "(see attached files)";

/** Resolve possibly-deferred extras to a concrete bag (function evaluated now). */
export function resolveSendExtras(
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
): ComposerSendExtras {
  return (typeof extras === "function" ? extras() : extras) ?? {};
}

/**
 * Merge the draft text + idempotency key with caller-provided extras. The
 * text and clientEventId always win over extras. Exported for tests.
 */
export function composeSendInput(
  text: string,
  clientEventId: string,
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
  bound: Partial<SendMessageInput> = {},
): SendMessageInput {
  return { ...resolveSendExtras(extras), ...bound, text, clientEventId };
}

/** Submit on plain Enter; Shift+Enter inserts a newline. Exported for tests. */
export function shouldSubmitOnKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== "Enter" || event.shiftKey) {
    return false;
  }
  return event.nativeEvent?.isComposing !== true;
}

/** Cmd/Ctrl+Enter steers; ordinary Enter appends to the queue. */
export function shouldSteerOnKey(event: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return event.metaKey === true || event.ctrlKey === true;
}

function generateClientEventId(): string {
  return globalThis.crypto.randomUUID();
}

function isOutcomeUnknownError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isDraftConflictError(error: Error): boolean {
  const apiError = error as Partial<OpenGeniApiError>;
  return (
    apiError.status === 409 &&
    apiError.outcomeUnknown === false &&
    (apiError.code === undefined ||
      apiError.code === "conflict" ||
      apiError.code === "idempotency_conflict")
  );
}

function draftPayload(draft: ComposerDraft): SaveComposerDraftRequest {
  return {
    expectedRevision: draft.revision,
    text: draft.text,
    resources: draft.resources,
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode ?? "standard",
  };
}

function composerDraftPayload(
  base: ComposerDraft,
  text: string,
  restoredResources: ResourceRef[],
  extras: ComposerSendExtras,
): SaveComposerDraftRequest {
  return {
    expectedRevision: base.revision,
    text,
    resources: mergeResources(restoredResources, extras.resources ?? []),
    model: extras.model ?? base.model,
    reasoningEffort: extras.reasoningEffort ?? base.reasoningEffort,
    latencyMode: extras.latencyMode ?? base.latencyMode ?? "standard",
  };
}

function draftSignature(payload: SaveComposerDraftRequest): string {
  const { expectedRevision: _revision, ...content } = payload;
  return JSON.stringify(content);
}

function mergeResources(base: ResourceRef[], additions: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return [...base, ...additions].filter((resource) => {
    // Reconnect reconciliation can restore the canonical server form while
    // the still-mounted upload card supplies the same ready file without its
    // default mount. Treat those two wire shapes as one selected attachment;
    // preserving the first representation keeps custom mounts and ordering
    // intact while preventing the draft and command paths from seeing
    // different duplicate counts after server normalization.
    const key =
      resource.kind === "file"
        ? `file:${resource.fileId}\u0000${resource.mountPath ?? `files/${resource.fileId}`}`
        : JSON.stringify(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
