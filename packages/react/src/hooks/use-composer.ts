import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  type ComposerDraft,
  type DraftTimelineAnnotation,
  type EffectiveControlResumeOption,
  type EffectiveSessionControl,
  type OpenGeniApiError,
  type ResourceRef,
  type SaveComposerDraftRequest,
  type SendMessageInput,
  type SessionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

export type ComposerSendExtras = Omit<SendMessageInput, "text" | "clientEventId" | "annotations">;

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
  annotations: DraftTimelineAnnotation[];
};

type PendingComposerOperation = {
  delivery: "send" | "steer";
  input: SendMessageInput;
  draftAtSend: string;
  resourcesAtSend: ResourceRef[];
  annotationsAtSend: DraftTimelineAnnotation[];
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

function timelineAnnotationList(value: unknown): value is DraftTimelineAnnotation[] {
  return (
    Array.isArray(value) &&
    value.every((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const annotation = candidate as Record<string, unknown>;
      const source = annotation.source;
      if (typeof source !== "object" || source === null) return false;
      const sourceRecord = source as Record<string, unknown>;
      return (
        typeof annotation.id === "string" &&
        typeof annotation.quote === "string" &&
        typeof annotation.note === "string" &&
        typeof sourceRecord.eventId === "string" &&
        typeof sourceRecord.eventType === "string" &&
        typeof sourceRecord.sequence === "number" &&
        (typeof sourceRecord.turnId === "string" || sourceRecord.turnId === null) &&
        typeof sourceRecord.startOffset === "number" &&
        typeof sourceRecord.endOffset === "number" &&
        typeof sourceRecord.contextBefore === "string" &&
        typeof sourceRecord.contextAfter === "string"
      );
    })
  );
}

function cloneAnnotations(
  annotations: readonly DraftTimelineAnnotation[],
): DraftTimelineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    source: { ...annotation.source },
  }));
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
      (record.annotationsAtSend !== undefined &&
        !timelineAnnotationList(record.annotationsAtSend)) ||
      typeof shadowRecord.text !== "string" ||
      !resourceList(shadowRecord.resources) ||
      (shadowRecord.annotations !== undefined &&
        !timelineAnnotationList(shadowRecord.annotations)) ||
      typeof record.clearDraftOnAccept !== "boolean" ||
      typeof record.hasMcpCredentialUpdates !== "boolean" ||
      typeof inputRecord.text !== "string" ||
      typeof inputRecord.clientEventId !== "string" ||
      "mcpCredentialUpdates" in inputRecord ||
      ("resources" in inputRecord && !resourceList(inputRecord.resources)) ||
      ("annotations" in inputRecord && !timelineAnnotationList(inputRecord.annotations))
    ) {
      return null;
    }
    return {
      ...(record as StoredPendingComposerOperation),
      annotationsAtSend: timelineAnnotationList(record.annotationsAtSend)
        ? record.annotationsAtSend
        : [],
      newerShadow: {
        ...(shadow as ComposerDraftShadow),
        annotations: timelineAnnotationList(shadowRecord.annotations)
          ? shadowRecord.annotations
          : [],
      },
    };
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
      annotations: stored.annotationsAtSend,
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
      annotations: cloneAnnotations(operation.newerShadow.annotations),
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
  const next = {
    ...operation,
    newerShadow: {
      ...shadow,
      resources: [...shadow.resources],
      annotations: cloneAnnotations(shadow.annotations),
    },
  };
  rememberPendingComposerOperation(key, next);
  return next;
}

export type ComposerState = {
  value: string;
  setValue: (value: string) => void;
  annotations?: DraftTimelineAnnotation[] | undefined;
  addAnnotation?: ((annotation: DraftTimelineAnnotation) => void) | undefined;
  updateAnnotation?: ((id: string, note: string) => void) | undefined;
  removeAnnotation?: ((id: string) => void) | undefined;
  /** Newly captured annotation the review surface should focus. */
  annotationReviewTargetId?: string | null | undefined;
  clearAnnotationReviewTarget?: (() => void) | undefined;
  /** Read the current draft synchronously before a destructive replacement. */
  hasDraftContent: () => boolean;
  /** Append the draft behind prompts already visible in the queue. */
  send: (text?: string) => Promise<boolean>;
  /** Supersede current direction with the draft. */
  steer: (text?: string) => Promise<boolean>;
  /** Optimistic-to-durable projection for a Steer that has not started yet. */
  steering?: ComposerSteeringState | null | undefined;
  /** Immediate mutation-receipt projection while physical cancellation settles. */
  stoppingAttempt?: "current" | "previous" | null | undefined;
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
  /** True only when the accepted Steer durably interrupted a live attempt. */
  stoppingPreviousAttempt?: boolean | undefined;
};

type ComposerControlStoppingState = {
  controlVersion: number;
  controlEtag: string;
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

function steeringAcceptedEvent(
  steering: ComposerSteeringState,
  events: readonly SessionEvent[],
): SessionEvent | undefined {
  return events.find(
    (event) =>
      event.type === "user.message" &&
      steering.clientEventId !== null &&
      event.clientEventId === steering.clientEventId,
  );
}

function steeringSettledByEvents(
  steering: ComposerSteeringState,
  events: readonly SessionEvent[],
): boolean {
  const acceptedEventId =
    steering.triggerEventId ?? steeringAcceptedEvent(steering, events)?.id ?? null;
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
  const [annotations, setAnnotations] = useState<DraftTimelineAnnotation[]>(
    () => initialShadow?.annotations ?? [],
  );
  const [annotationReviewTargetId, setAnnotationReviewTargetId] = useState<string | null>(null);
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
  const [controlStopping, setControlStopping] = useState<ComposerControlStoppingState | null>(null);
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
  const steeringRef = useRef(steering);
  const pendingClientEventId = useRef<string | null>(
    initialPendingOperation?.input.clientEventId ?? null,
  );
  const valueRef = useRef(initialShadow?.text ?? "");
  const annotationsRef = useRef<DraftTimelineAnnotation[]>(initialShadow?.annotations ?? []);
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
  useLayoutEffect(() => {
    steeringRef.current = steering;
  }, [steering]);
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
    annotationsRef.current = shadow?.annotations ?? [];
    draftRef.current = null;
    restoredResourcesRef.current = shadow?.resources ?? [];
    lastSavedSignature.current = null;
    // Old saves may still be awaiting the network. Their generation fence
    // prevents settlement, and a fresh chain avoids blocking this target.
    saveChain.current = Promise.resolve();
    setStateTargetKey(targetKey);
    setValue(shadow?.text ?? "");
    setAnnotations(shadow?.annotations ?? []);
    setAnnotationReviewTargetId(null);
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
    setControlStopping(null);
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
        annotationsRef.current = next.annotations ?? [];
        restoredResourcesRef.current = next.resources;
        draftRef.current = null;
        lastSavedSignature.current = null;
        setDraft(null);
        setValue(next.text);
        setAnnotations(next.annotations ?? []);
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
            annotations: next.annotations ?? [],
          },
        );
        setDraftConflict(null);
        return;
      }
      valueRef.current = next.text;
      annotationsRef.current = next.annotations ?? [];
      draftRef.current = next;
      restoredResourcesRef.current = next.resources;
      lastSavedSignature.current = draftSignature(draftPayload(next));
      localEditRevision.current += 1;
      setDraft(next);
      setValue(next.text);
      setAnnotations(next.annotations ?? []);
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
          annotations: next.annotations ?? [],
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
              annotationsRef.current,
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
            annotationsRef.current = shadow.annotations;
            localEditRevision.current ||= 1;
            setValue(shadow.text);
            setRestoredResources(shadow.resources);
            setAnnotations(shadow.annotations);
          } else if (
            replaceLocal ||
            (!localWasDirtyAtStart && localAtStart === localEditRevision.current)
          ) {
            // Model/effort/latency ride in sendExtras (outside
            // localEditRevision). If
            // the picker changed during this fetch, skip onDraftApplied so a
            // stale server policy cannot undo the operator's pick.
            const extrasNow = resolveSendExtras(sendExtrasRef.current);
            const pickerChangedDuringFetch =
              extrasNow.model !== extrasAtStart.model ||
              extrasNow.reasoningEffort !== extrasAtStart.reasoningEffort ||
              extrasNow.latencyMode !== extrasAtStart.latencyMode;
            valueRef.current = fetched.text;
            restoredResourcesRef.current = fetched.resources;
            annotationsRef.current = fetched.annotations ?? [];
            lastSavedSignature.current = draftSignature(draftPayload(fetched));
            setValue(fetched.text);
            setRestoredResources(fetched.resources);
            setAnnotations(fetched.annotations ?? []);
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
  // After long background / sleep the in-memory revision is often stale while
  // a prior autosave already advanced the server. Soft-reload on wake so the
  // next keystroke does not OCC against a dead revision.
  useEffect(() => {
    if (!sessionId || !durableDrafts) return;
    const onWake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadDraft(false);
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [durableDrafts, loadDraft, sessionId]);
  useEffect(() => {
    if (!sessionId || !durableDrafts) return;
    return registerSessionReconciler(sessionId, "composer", async () => await loadDraft(false));
  }, [durableDrafts, loadDraft, registerSessionReconciler, sessionId]);
  const reconcileSteering = useCallback(async (): Promise<void> => {
    if (!sessionId || !steeringRef.current) return;
    const ownedTargetKey = targetKey;
    let events: SessionEvent[];
    try {
      events = await client.listEvents(workspaceId, sessionId, {
        includeTypes: [
          "user.message",
          "turn.started",
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
          "turn.superseded",
        ],
        limit: 250,
        payloadMode: "full",
      });
    } catch {
      // Best effort: the live stream still settles steering when its event arrives.
      return;
    }
    if (targetKeyRef.current !== ownedTargetKey) return;
    setSteering((current) => {
      if (!current) return current;
      if (steeringSettledByEvents(current, events)) {
        steeringSettlementEventsRef.current = [];
        return null;
      }
      const accepted = steeringAcceptedEvent(current, events);
      if (!accepted || current.triggerEventId) return current;
      return {
        ...current,
        phase: "accepted",
        triggerEventId: accepted.id,
      };
    });
  }, [client, sessionId, targetKey, workspaceId]);
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
    reconcileSteering,
  );

  useEffect(() => {
    if (!steering) return;
    const observed = [...(options.events ?? []), ...steeringSettlementEventsRef.current];
    if (!steeringSettledByEvents(steering, observed)) return;
    steeringSettlementEventsRef.current = [];
    setSteering(null);
  }, [options.events, steering]);

  useEffect(() => {
    if (!controlStopping) return;
    const effectiveControl = options.effectiveControl;
    if (!effectiveControl || effectiveControl.controlVersion < controlStopping.controlVersion) {
      return;
    }
    if (
      effectiveControl.controlVersion === controlStopping.controlVersion &&
      effectiveControl.controlEtag === controlStopping.controlEtag &&
      effectiveControl.settlement !== null
    ) {
      return;
    }
    // A newer control revision, an impossible same-version/different-etag
    // projection, or quiescence at this exact revision supersedes the local
    // mutation receipt. SessionChrome then falls back to durable queue truth.
    setControlStopping((current) => (current === controlStopping ? null : current));
  }, [controlStopping, options.effectiveControl]);

  const currentDraftPayload = useCallback((): SaveComposerDraftRequest | null => {
    if (!durableDrafts || targetKeyRef.current !== targetKey) return null;
    const base = draftRef.current;
    if (!base) return null;
    const extras = resolveSendExtras(sendExtrasRef.current);
    return composerDraftPayload(base, value, restoredResources, annotations, extras);
  }, [annotations, durableDrafts, restoredResources, targetKey, value]);

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
          const saved = await saveComposerDraftWithStaleRetry({
            client,
            workspaceId,
            sessionId,
            request,
            onAdoptRemote: (remote) => {
              draftRef.current = remote;
              setDraft(remote);
            },
          });
          if (
            targetKeyRef.current !== ownedTargetKey ||
            targetGeneration.current !== ownedGeneration
          ) {
            return;
          }
          draftRef.current = saved;
          setDraft(saved);
          lastSavedSignature.current = draftSignature({
            ...request,
            expectedRevision: saved.revision,
          });
          setDraftConflict(null);
          setError(null);
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
        annotations: annotationsRef.current,
      };
      if (
        pending.newerShadow.text !== shadow.text ||
        JSON.stringify(pending.newerShadow.resources) !== JSON.stringify(shadow.resources) ||
        JSON.stringify(pending.newerShadow.annotations) !== JSON.stringify(shadow.annotations)
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
      const annotationsAtSend = annotations;
      const rawText = explicit ?? draftAtSend;
      const hasText = rawText.trim().length > 0;
      const hasAnnotations = annotationsAtSend.length > 0;
      const annotationsComplete = annotationsAtSend.every(
        (annotation) => annotation.note.trim().length > 0,
      );
      // Resolve the extras once: a file-only message (empty text + ≥1 ready
      // resource) is legitimate, so we must not bail on empty text alone.
      const extras = pending ? {} : resolveSendExtras(sendExtrasRef.current);
      const hasResources = restoredResources.length > 0 || (extras.resources?.length ?? 0) > 0;
      if (
        (!pending && (!annotationsComplete || (!hasText && !hasResources && !hasAnnotations))) ||
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
        const annotationsWereUnchanged =
          JSON.stringify(annotationsRef.current) === JSON.stringify(operation.annotationsAtSend);
        const previousDraft = draftRef.current;
        if (previousDraft) {
          const cleared = {
            ...previousDraft,
            revision: 0,
            text: "",
            resources: [],
            annotations: [],
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
        if (annotationsWereUnchanged) {
          annotationsRef.current = [];
          setAnnotations([]);
          setAnnotationReviewTargetId(null);
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
                stoppingPreviousAttempt:
                  result.replay !== true && (result.interruptionCount ?? 0) > 0,
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
        const sendText = hasText ? rawText : hasAnnotations ? "" : FILE_ONLY_MESSAGE_TEXT;
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
          annotations: cloneAnnotations(annotationsAtSend),
        });
        const operation: PendingComposerOperation = {
          delivery,
          input,
          draftAtSend,
          resourcesAtSend: [...restoredResources],
          annotationsAtSend: cloneAnnotations(annotationsAtSend),
          newerShadow: {
            text: draftAtSend,
            resources: mergeResources(restoredResources, extras.resources ?? []),
            annotations: cloneAnnotations(annotationsAtSend),
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
              stoppingPreviousAttempt:
                result.replay !== true && (result.interruptionCount ?? 0) > 0,
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
      annotations,
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
  const annotationsComplete = annotations.every((annotation) => annotation.note.trim().length > 0);

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
        const result = await client.pauseSession(workspaceId, sessionId, {
          ...(reason !== undefined ? { reason } : {}),
          ...(options.effectiveControl?.controlEtag
            ? { expectedControlEtag: options.effectiveControl.controlEtag }
            : {}),
        });
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          setControlStopping(
            result.interruptionCount > 0 &&
              result.effectiveControl.state === "paused" &&
              result.effectiveControl.settlement !== null
              ? {
                  controlVersion: result.effectiveControl.controlVersion,
                  controlEtag: result.effectiveControl.controlEtag,
                }
              : null,
          );
        }
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
          annotations: annotationsRef.current,
        },
      );
      setValue(next);
    },
    [pendingOperationKey, targetKey],
  );

  const updateAnnotations = useCallback(
    (next: DraftTimelineAnnotation[], reviewTargetId: string | null = null) => {
      if (targetKeyRef.current !== targetKey) return;
      localEditRevision.current += 1;
      annotationsRef.current = next;
      pendingOperationRef.current = updatePendingComposerShadow(
        pendingOperationKey,
        pendingOperationRef.current,
        {
          text: valueRef.current,
          resources: mergeResources(
            restoredResourcesRef.current,
            resolveSendExtras(sendExtrasRef.current).resources ?? [],
          ),
          annotations: next,
        },
      );
      setAnnotations(next);
      setAnnotationReviewTargetId(reviewTargetId);
    },
    [pendingOperationKey, targetKey],
  );

  const addAnnotation = useCallback(
    (annotation: DraftTimelineAnnotation) => {
      if (annotationsRef.current.length >= 12) {
        setError(new Error("A message can include at most 12 timeline annotations."));
        return;
      }
      const next = [...annotationsRef.current, annotation];
      updateAnnotations(next, annotation.id);
    },
    [updateAnnotations],
  );

  const updateAnnotation = useCallback(
    (id: string, note: string) => {
      updateAnnotations(
        annotationsRef.current.map((annotation) =>
          annotation.id === id ? { ...annotation, note } : annotation,
        ),
      );
    },
    [updateAnnotations],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      updateAnnotations(annotationsRef.current.filter((annotation) => annotation.id !== id));
    },
    [updateAnnotations],
  );

  const clearAnnotationReviewTarget = useCallback(() => {
    setAnnotationReviewTargetId(null);
  }, []);

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
          annotations: annotationsRef.current,
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
      annotationsRef.current.length > 0 ||
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
        setError(null);
        return;
      }
      draftRef.current = remote;
      setDraft(remote);
      setDraftConflict(null);
      setError(null);
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
  const visibleSteering = identityMatches ? steering : null;
  const reloadDraft = useCallback(async () => await loadDraft(true), [loadDraft]);
  const clearError = useCallback(() => {
    if (targetKeyRef.current !== targetKey) return;
    setError(null);
    setDraftConflict(null);
  }, [targetKey]);

  return {
    value: identityMatches ? value : "",
    setValue: updateValue,
    annotations: identityMatches ? annotations : [],
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    annotationReviewTargetId: identityMatches ? annotationReviewTargetId : null,
    clearAnnotationReviewTarget,
    hasDraftContent,
    send,
    steer,
    steering: visibleSteering,
    stoppingAttempt: identityMatches
      ? controlStopping
        ? "current"
        : visibleSteering?.phase === "accepted" && visibleSteering.stoppingPreviousAttempt === true
          ? "previous"
          : null
      : null,
    sending: identityMatches ? sending : false,
    canSend:
      identityMatches &&
      Boolean(sessionId) &&
      !sending &&
      sendBlockedRef.current?.() !== true &&
      annotationsComplete &&
      (hasPendingOperation ||
        value.trim().length > 0 ||
        hasReadyResources ||
        annotations.length > 0),
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
  if (apiError.status !== 409 || apiError.outcomeUnknown === true) return false;
  // Production queue OCC returns `DRAFT_CHANGED`. Older/SDK-shaped 409s may
  // omit code or use the generic conflict labels — all are recoverable OCC.
  const code = apiError.code;
  if (
    code === undefined ||
    code === "DRAFT_CHANGED" ||
    code === "conflict" ||
    code === "idempotency_conflict"
  ) {
    return true;
  }
  return /draft changed/i.test(error.message);
}

/**
 * One OCC retry: adopt the server revision and rewrite the same local content.
 * Covers the common "tab slept through a successful autosave" case without
 * stranding the operator on a raw 409 toast.
 */
async function saveComposerDraftWithStaleRetry(input: {
  client: {
    getComposerDraft: (workspaceId: string, sessionId: string) => Promise<ComposerDraft>;
    saveComposerDraft: (
      workspaceId: string,
      sessionId: string,
      request: SaveComposerDraftRequest,
    ) => Promise<ComposerDraft>;
  };
  workspaceId: string;
  sessionId: string;
  request: SaveComposerDraftRequest;
  onAdoptRemote: (remote: ComposerDraft) => void;
}): Promise<ComposerDraft> {
  try {
    return await input.client.saveComposerDraft(input.workspaceId, input.sessionId, input.request);
  } catch (cause) {
    const problem = asError(cause);
    if (!isDraftConflictError(problem)) throw problem;
    const remote = await input.client.getComposerDraft(input.workspaceId, input.sessionId);
    input.onAdoptRemote(remote);
    return await input.client.saveComposerDraft(input.workspaceId, input.sessionId, {
      ...input.request,
      expectedRevision: remote.revision,
    });
  }
}

function draftPayload(draft: ComposerDraft): SaveComposerDraftRequest {
  return {
    expectedRevision: draft.revision,
    text: draft.text,
    resources: draft.resources,
    annotations: draft.annotations ?? [],
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode ?? "standard",
  };
}

function composerDraftPayload(
  base: ComposerDraft,
  text: string,
  restoredResources: ResourceRef[],
  annotations: DraftTimelineAnnotation[],
  extras: ComposerSendExtras,
): SaveComposerDraftRequest {
  return {
    expectedRevision: base.revision,
    text,
    resources: mergeResources(restoredResources, extras.resources ?? []),
    annotations,
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
        ? `file:${resource.fileId}\u0000${resource.mountPath ?? `${DEFAULT_FILE_RESOURCE_MOUNT_ROOT}/${resource.fileId}`}`
        : JSON.stringify(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
