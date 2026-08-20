import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  type ComposerDraft,
  type DraftTimelineAnnotation,
  type EffectiveControlResumeOption,
  type EffectiveSessionControl,
  type LatencyMode,
  type OpenGeniApiError,
  type ReasoningEffort,
  type ResourceRef,
  type SaveComposerDraftRequest,
  type SendMessageInput,
  type SessionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

export type ComposerPolicy = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

export type ComposerSendExtras = Omit<
  SendMessageInput,
  "text" | "clientEventId" | "annotations" | "model" | "reasoningEffort" | "latencyMode"
>;

export type UseComposerOptions = EmbeddedSessionClientOverride &
  SessionEventFeedOptions & {
    /** Called synchronously after an ordinary Send is accepted by the local UI. */
    onSubmitted?: ((text: string, input: SendMessageInput) => void) | undefined;
    /** Called with the exact accepted wire input after a successful send. */
    onSent?: ((text: string, input: SendMessageInput) => void) | undefined;
    /** Called with the exact wire input after a delivery failure. */
    onDeliveryError?:
      | ((error: Error, input: SendMessageInput, delivery: "send" | "steer") => void)
      | undefined;
    /**
     * Non-policy message fields merged into every send. Durable policy belongs
     * to this composer draft; attachments and credentials may remain host-owned.
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
    /** Disable remote composer-draft reads and writes for embedded hosts. */
    draftPersistence?: "durable" | "disabled" | undefined;
    /** Required explicit authority when durable draft persistence is disabled. */
    initialPolicy?: ComposerPolicy | undefined;
  };

type ComposerDraftShadow = {
  text: string;
  resources: ResourceRef[];
  annotations: DraftTimelineAnnotation[];
  policy?: ComposerPolicy | undefined;
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

export type ComposerOptimisticMessage = {
  clientEventId: string;
  text: string;
  annotations: DraftTimelineAnnotation[];
  resources: ResourceRef[];
  occurredAt: string;
  state: "sending" | "queued" | "failed";
  error?: string | undefined;
  outcomeUnknown?: boolean | undefined;
};

type OptimisticSendOperation = ComposerOptimisticMessage & {
  input: SendMessageInput;
  draftPayload: SaveComposerDraftRequest | null;
  /** Latest unsent local draft that must survive this operation and remounts. */
  newerShadow: ComposerDraftShadow;
  canRetry: boolean;
};

type StoredOptimisticSendOperation = Omit<OptimisticSendOperation, "input" | "canRetry"> & {
  input: Omit<SendMessageInput, "mcpCredentialUpdates">;
  hasMcpCredentialUpdates: boolean;
};

const PENDING_COMPOSER_STORAGE_PREFIX = "opengeni.pending-composer.v1:";
const OPTIMISTIC_SEND_STORAGE_PREFIX = "opengeni.optimistic-sends.v1:";

// A remount must not manufacture a new operation while the previous mutation
// is still outcome-unknown. Keep only non-credential request fields here; the
// mounted hook retains the exact input, including any credential updates. The
// safe shadow is also session-scoped so a refresh cannot lose newer edits.
const pendingComposerOperations = new Map<string, StoredPendingComposerOperation>();
const optimisticSendOperations = new Map<string, StoredOptimisticSendOperation[]>();

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

function optimisticSendStorageKey(key: string): string {
  return `${OPTIMISTIC_SEND_STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function restoreOptimisticSendOperations(key: string | null): OptimisticSendOperation[] {
  if (!key) return [];
  let stored = optimisticSendOperations.get(key);
  if (!stored) {
    const storage = pendingComposerStorage();
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(optimisticSendStorageKey(key)) ?? "[]");
      stored = Array.isArray(parsed)
        ? (parsed.filter(
            (candidate): candidate is StoredOptimisticSendOperation =>
              typeof candidate === "object" &&
              candidate !== null &&
              typeof candidate.clientEventId === "string" &&
              typeof candidate.text === "string" &&
              typeof candidate.occurredAt === "string" &&
              (candidate.state === "sending" || candidate.state === "failed") &&
              typeof candidate.input === "object" &&
              candidate.input !== null &&
              typeof candidate.input.text === "string" &&
              typeof candidate.hasMcpCredentialUpdates === "boolean",
          ) as StoredOptimisticSendOperation[])
        : [];
    } catch {
      stored = [];
    }
  }
  return stored.map(({ hasMcpCredentialUpdates, ...operation }) => ({
    ...operation,
    newerShadow: operation.newerShadow ?? { text: "", resources: [], annotations: [] },
    state:
      operation.state === "sending" || operation.state === "queued" ? "sending" : operation.state,
    outcomeUnknown:
      operation.state === "sending" || operation.state === "queued"
        ? true
        : operation.outcomeUnknown,
    error:
      operation.state === "sending"
        ? "Delivery was interrupted; retry to reconcile this message."
        : operation.error,
    input: operation.input,
    canRetry: !hasMcpCredentialUpdates,
  }));
}

function rememberOptimisticSendOperations(
  key: string | null,
  operations: OptimisticSendOperation[],
): void {
  if (!key) return;
  const stored = operations
    .filter((operation) => operation.state !== "queued")
    .map((operation) => {
      const { canRetry: _canRetry, input, ...rest } = operation;
      const { mcpCredentialUpdates: _credentials, ...safeInput } = input;
      return {
        ...rest,
        input: safeInput,
        hasMcpCredentialUpdates: input.mcpCredentialUpdates !== undefined,
      } satisfies StoredOptimisticSendOperation;
    });
  optimisticSendOperations.set(key, stored);
  try {
    pendingComposerStorage()?.setItem(optimisticSendStorageKey(key), JSON.stringify(stored));
  } catch {
    // Best effort; the in-memory queue still owns this mount.
  }
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
      ...(operation.newerShadow.policy ? { policy: { ...operation.newerShadow.policy } } : {}),
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
  /** Locally acknowledged ordinary sends awaiting durable timeline reconciliation. */
  optimisticMessages?: ComposerOptimisticMessage[] | undefined;
  retryOptimisticMessage?: ((clientEventId: string) => void) | undefined;
  removeOptimisticMessage?: ((clientEventId: string) => void) | undefined;
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
  /** Exact policy owned by this actor/session composer. Null while hydrating. */
  policy?: ComposerPolicy | null | undefined;
  setModel?: ((model: string) => void) | undefined;
  setReasoningEffort?: ((effort: ReasoningEffort) => void) | undefined;
  setLatencyMode?: ((mode: LatencyMode) => void) | undefined;
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

export type ComposerControllerState = ComposerState & {
  policy: ComposerPolicy | null;
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  setLatencyMode: (mode: LatencyMode) => void;
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
): ComposerControllerState {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedSession(options);
  const durableDrafts = options.draftPersistence !== "disabled";
  if (!durableDrafts && !options.initialPolicy) {
    throw new Error("useComposer requires initialPolicy when draft persistence is disabled");
  }
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${durableDrafts ? "durable" : "disabled"}`;
  const pendingOperationKey = pendingComposerOperationKey(workspaceId, sessionId);
  const initialPendingOperation = restorePendingComposerOperation(pendingOperationKey);
  const initialOptimisticSends = restoreOptimisticSendOperations(pendingOperationKey);
  const initialShadow =
    initialPendingOperation?.newerShadow ?? initialOptimisticSends.at(-1)?.newerShadow;
  const [value, setValue] = useState(() => initialShadow?.text ?? "");
  const [annotations, setAnnotations] = useState<DraftTimelineAnnotation[]>(
    () => initialShadow?.annotations ?? [],
  );
  const [annotationReviewTargetId, setAnnotationReviewTargetId] = useState<string | null>(null);
  // Keep rendered state behind the committed target identity for one frame:
  // a parent may switch sessionId without remounting this public hook.
  const [stateTargetKey, setStateTargetKey] = useState(targetKey);
  const [sending, setSending] = useState(false);
  const [optimisticSends, setOptimisticSends] =
    useState<OptimisticSendOperation[]>(initialOptimisticSends);
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
  const [policy, setPolicy] = useState<ComposerPolicy | null>(
    () => initialShadow?.policy ?? options.initialPolicy ?? null,
  );
  const [restoredResources, setRestoredResources] = useState<ResourceRef[]>(
    () => initialShadow?.resources ?? [],
  );
  const pendingOperationRef = useRef<PendingComposerOperation | null>(initialPendingOperation);
  const optimisticSendsRef = useRef<OptimisticSendOperation[]>(initialOptimisticSends);
  const optimisticProcessorBusyRef = useRef(false);
  const optimisticCallbackIdsRef = useRef(new Set<string>());
  const steeringSettlementEventsRef = useRef<SessionEvent[]>([]);
  const steeringRef = useRef(steering);
  const pendingClientEventId = useRef<string | null>(
    initialPendingOperation?.input.clientEventId ?? null,
  );
  const valueRef = useRef(initialShadow?.text ?? "");
  const annotationsRef = useRef<DraftTimelineAnnotation[]>(initialShadow?.annotations ?? []);
  const policyRef = useRef<ComposerPolicy | null>(
    initialShadow?.policy ?? options.initialPolicy ?? null,
  );
  const draftRef = useRef<ComposerDraft | null>(null);
  const restoredResourcesRef = useRef<ResourceRef[]>(initialShadow?.resources ?? []);
  const localEditRevision = useRef(initialShadow ? 1 : 0);
  const targetGeneration = useRef(0);
  const draftReadGeneration = useRef(0);
  const lastSavedSignature = useRef<string | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const onSent = options.onSent;
  const onSubmitted = options.onSubmitted;
  const onDeliveryErrorRef = useRef(options.onDeliveryError);
  onDeliveryErrorRef.current = options.onDeliveryError;
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
    const restoredOptimisticSends = restoreOptimisticSendOperations(pendingOperationKey);
    optimisticSendsRef.current = restoredOptimisticSends;
    optimisticProcessorBusyRef.current = false;
    optimisticCallbackIdsRef.current = new Set();
    steeringSettlementEventsRef.current = [];
    pendingClientEventId.current = pendingOperationRef.current?.input.clientEventId ?? null;
    const shadow =
      pendingOperationRef.current?.newerShadow ?? restoredOptimisticSends.at(-1)?.newerShadow;
    localEditRevision.current = shadow ? 1 : 0;
    valueRef.current = shadow?.text ?? "";
    annotationsRef.current = shadow?.annotations ?? [];
    policyRef.current = shadow?.policy ?? options.initialPolicy ?? null;
    draftRef.current = null;
    restoredResourcesRef.current = shadow?.resources ?? [];
    lastSavedSignature.current = null;
    // Old saves may still be awaiting the network. Their generation fence
    // prevents settlement, and a fresh chain avoids blocking this target.
    saveChain.current = Promise.resolve();
    setStateTargetKey(targetKey);
    setValue(shadow?.text ?? "");
    setAnnotations(shadow?.annotations ?? []);
    setPolicy(policyRef.current);
    setAnnotationReviewTargetId(null);
    setSending(false);
    setOptimisticSends(restoredOptimisticSends);
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
  }, [durableDrafts, options.initialPolicy, pendingOperationKey, sessionId, targetKey]);

  const setOptimisticDraftShadow = useCallback(
    (shadow: ComposerDraftShadow): void => {
      if (optimisticSendsRef.current.length === 0) return;
      const next = optimisticSendsRef.current.map((operation) => ({
        ...operation,
        newerShadow: {
          text: shadow.text,
          resources: [...shadow.resources],
          annotations: cloneAnnotations(shadow.annotations),
          ...(shadow.policy ? { policy: { ...shadow.policy } } : {}),
        },
      }));
      optimisticSendsRef.current = next;
      rememberOptimisticSendOperations(pendingOperationKey, next);
      setOptimisticSends(next);
    },
    [pendingOperationKey],
  );

  const applyDraft = useCallback(
    (next: ComposerDraft): void => {
      if (targetKeyRef.current !== targetKey) return;
      if (!durableDrafts) {
        const nextPolicy = policyFromDraft(next);
        localEditRevision.current += 1;
        valueRef.current = next.text;
        annotationsRef.current = next.annotations ?? [];
        policyRef.current = nextPolicy;
        restoredResourcesRef.current = next.resources;
        draftRef.current = null;
        lastSavedSignature.current = null;
        setDraft(null);
        setValue(next.text);
        setAnnotations(next.annotations ?? []);
        setPolicy(nextPolicy);
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
            policy: nextPolicy,
          },
        );
        setOptimisticDraftShadow({
          text: next.text,
          resources: mergeResources(
            next.resources,
            resolveSendExtras(sendExtrasRef.current).resources ?? [],
          ),
          annotations: next.annotations ?? [],
          policy: nextPolicy,
        });
        setDraftConflict(null);
        return;
      }
      const nextPolicy = policyFromDraft(next);
      valueRef.current = next.text;
      annotationsRef.current = next.annotations ?? [];
      policyRef.current = nextPolicy;
      draftRef.current = next;
      restoredResourcesRef.current = next.resources;
      lastSavedSignature.current = draftSignature(draftPayload(next));
      localEditRevision.current += 1;
      setDraft(next);
      setValue(next.text);
      setAnnotations(next.annotations ?? []);
      setPolicy(nextPolicy);
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
          policy: nextPolicy,
        },
      );
      setOptimisticDraftShadow({
        text: next.text,
        resources: mergeResources(
          next.resources,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
        annotations: next.annotations ?? [],
        policy: nextPolicy,
      });
      setDraftConflict(null);
    },
    [durableDrafts, pendingOperationKey, setOptimisticDraftShadow, targetKey],
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
      const policyAtStart = policyRef.current;
      const localSignatureAtStart = baseAtStart
        ? policyAtStart
          ? draftSignature(
              composerDraftPayload(
                baseAtStart,
                valueRef.current,
                restoredResourcesRef.current,
                annotationsRef.current,
                policyAtStart,
                resolveSendExtras(sendExtrasRef.current).resources ?? [],
              ),
            )
          : null
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
          const shadow =
            pendingOperationRef.current?.newerShadow ??
            optimisticSendsRef.current.at(-1)?.newerShadow;
          if (shadow) {
            // The server can only know the original operation. Never replace
            // newer local edits while that operation is still uncertain.
            valueRef.current = shadow.text;
            restoredResourcesRef.current = shadow.resources;
            annotationsRef.current = shadow.annotations;
            if (shadow.policy) policyRef.current = shadow.policy;
            localEditRevision.current ||= 1;
            setValue(shadow.text);
            setRestoredResources(shadow.resources);
            setAnnotations(shadow.annotations);
            if (shadow.policy) setPolicy(shadow.policy);
          } else if (
            replaceLocal ||
            (!localWasDirtyAtStart && localAtStart === localEditRevision.current)
          ) {
            const fetchedPolicy = policyFromDraft(fetched);
            valueRef.current = fetched.text;
            restoredResourcesRef.current = fetched.resources;
            annotationsRef.current = fetched.annotations ?? [];
            policyRef.current = fetchedPolicy;
            lastSavedSignature.current = draftSignature(draftPayload(fetched));
            setValue(fetched.text);
            setRestoredResources(fetched.resources);
            setAnnotations(fetched.annotations ?? []);
            setPolicy(fetchedPolicy);
          } else {
            // Keep the in-flight edit, but the fetched row is still the OCC
            // base. First hydrate has no local policy until this read lands;
            // without it autosave cannot persist the typed text.
            lastSavedSignature.current = draftSignature(draftPayload(fetched));
            if (!policyRef.current) {
              const fetchedPolicy = policyFromDraft(fetched);
              policyRef.current = fetchedPolicy;
              setPolicy(fetchedPolicy);
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
    const currentPolicy = policyRef.current;
    if (!base || !currentPolicy) return null;
    return composerDraftPayload(
      base,
      value,
      restoredResources,
      annotations,
      currentPolicy,
      resolveSendExtras(sendExtrasRef.current).resources ?? [],
    );
  }, [annotations, durableDrafts, restoredResources, targetKey, value]);

  const adoptDraftBase = useCallback(
    (next: ComposerDraft): void => {
      if (targetKeyRef.current !== targetKey) return;
      draftRef.current = next;
      setDraft(next);
      lastSavedSignature.current = draftSignature(draftPayload(next));
      setDraftConflict(null);
      setError(null);
    },
    [targetKey],
  );

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
          adoptDraftBase(saved);
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
    [adoptDraftBase, client, durableDrafts, sessionId, targetKey, workspaceId],
  );

  const replaceOptimisticSends = useCallback(
    (
      update: (current: OptimisticSendOperation[]) => OptimisticSendOperation[],
    ): OptimisticSendOperation[] => {
      const next = update(optimisticSendsRef.current);
      optimisticSendsRef.current = next;
      rememberOptimisticSendOperations(pendingOperationKey, next);
      setOptimisticSends(next);
      return next;
    },
    [pendingOperationKey],
  );

  const markOptimisticAccepted = useCallback(
    (operation: OptimisticSendOperation): void => {
      if (!optimisticCallbackIdsRef.current.has(operation.clientEventId)) {
        optimisticCallbackIdsRef.current.add(operation.clientEventId);
        onSent?.(operation.input.text, operation.input);
      }
      replaceOptimisticSends((current) =>
        current.filter((candidate) => candidate.clientEventId !== operation.clientEventId),
      );
    },
    [onSent, replaceOptimisticSends],
  );

  useEffect(() => {
    const acceptedIds = new Set(
      (options.events ?? [])
        .filter((event) => event.type === "user.message" && event.clientEventId)
        .map((event) => event.clientEventId as string),
    );
    if (acceptedIds.size === 0) return;
    const accepted = optimisticSendsRef.current.filter((operation) =>
      acceptedIds.has(operation.clientEventId),
    );
    for (const operation of accepted) markOptimisticAccepted(operation);
  }, [markOptimisticAccepted, options.events]);

  const processOptimisticSends = useCallback((): void => {
    if (!sessionId || optimisticProcessorBusyRef.current) return;
    const currentOperations = optimisticSendsRef.current;
    const operationIndex = currentOperations.findIndex(
      (candidate) => candidate.state === "sending",
    );
    const operation = operationIndex < 0 ? undefined : currentOperations[operationIndex];
    if (!operation) return;
    const ownedTargetKey = targetKey;
    const ownedGeneration = targetGeneration.current;
    optimisticProcessorBusyRef.current = true;
    void (async () => {
      try {
        if (operation.outcomeUnknown) {
          const events = await client.listEvents(workspaceId, sessionId, {
            includeTypes: ["user.message"],
            limit: 100,
            payloadMode: "none",
          });
          if (
            events.some(
              (event) =>
                event.type === "user.message" && event.clientEventId === operation.clientEventId,
            )
          ) {
            if (durableDrafts) await loadDraft(false);
            markOptimisticAccepted(operation);
            return;
          }
          if (!operation.canRetry) {
            throw new Error(
              "OpenGeni cannot safely retry this uncertain request after remount; reconcile the session before sending again.",
            );
          }
        }
        let expectedDraftRevision: number | undefined;
        if (durableDrafts && operation.draftPayload) {
          if (!(await persistPayload(operation.draftPayload))) {
            throw new Error("The message draft could not be saved before delivery.");
          }
          expectedDraftRevision = draftRef.current?.revision;
        }
        if (
          targetKeyRef.current !== ownedTargetKey ||
          targetGeneration.current !== ownedGeneration
        ) {
          return;
        }
        const wireInput = {
          ...operation.input,
          ...(expectedDraftRevision !== undefined ? { expectedDraftRevision } : {}),
        };
        if (durableDrafts) {
          if (!operation.draftPayload || expectedDraftRevision === undefined) {
            throw new Error("The durable composer draft is not ready for delivery.");
          }
          const result = await client.submitComposerDraft(workspaceId, sessionId, {
            text: operation.draftPayload.text,
            annotations: operation.draftPayload.annotations,
            resources: operation.draftPayload.resources,
            model: operation.draftPayload.model,
            reasoningEffort: operation.draftPayload.reasoningEffort,
            latencyMode: operation.draftPayload.latencyMode,
            expectedDraftRevision,
            clientEventId: operation.clientEventId,
            delivery: "send",
            ...(wireInput.controlEtag ? { controlEtag: wireInput.controlEtag } : {}),
            ...(wireInput.modelContext ? { modelContext: wireInput.modelContext } : {}),
            ...(wireInput.mcpCredentialUpdates
              ? { mcpCredentialUpdates: wireInput.mcpCredentialUpdates }
              : {}),
            ...(wireInput.connectionAuthorities
              ? { connectionAuthorities: wireInput.connectionAuthorities }
              : {}),
            ...(wireInput.personalResourceAttachment
              ? { personalResourceAttachment: wireInput.personalResourceAttachment }
              : {}),
          });
          adoptDraftBase(result.draft);
        } else {
          await client.sendMessage(workspaceId, sessionId, wireInput);
        }
        if (
          targetKeyRef.current !== ownedTargetKey ||
          targetGeneration.current !== ownedGeneration
        ) {
          return;
        }
        if (options.events === undefined) {
          markOptimisticAccepted({ ...operation, input: wireInput });
        } else {
          replaceOptimisticSends((current) =>
            current.map((candidate) =>
              candidate.clientEventId === operation.clientEventId
                ? { ...candidate, input: wireInput, state: "queued", error: undefined }
                : candidate,
            ),
          );
        }
        if (!optimisticCallbackIdsRef.current.has(operation.clientEventId)) {
          optimisticCallbackIdsRef.current.add(operation.clientEventId);
          onSent?.(wireInput.text, wireInput);
        }
      } catch (cause) {
        const problem = asError(cause);
        onDeliveryErrorRef.current?.(problem, operation.input, "send");
        const outcomeUnknown = isOutcomeUnknownError(cause) || operation.outcomeUnknown === true;
        if (
          targetKeyRef.current === ownedTargetKey &&
          targetGeneration.current === ownedGeneration
        ) {
          replaceOptimisticSends((current) =>
            current.map((candidate) =>
              candidate.clientEventId === operation.clientEventId
                ? {
                    ...candidate,
                    state: "failed",
                    error: problem.message,
                    outcomeUnknown,
                  }
                : candidate,
            ),
          );
        }
      } finally {
        optimisticProcessorBusyRef.current = false;
        if (targetKeyRef.current === ownedTargetKey) {
          setOptimisticSends([...optimisticSendsRef.current]);
        }
      }
    })();
  }, [
    adoptDraftBase,
    client,
    durableDrafts,
    markOptimisticAccepted,
    loadDraft,
    onSent,
    options.events,
    persistPayload,
    replaceOptimisticSends,
    sessionId,
    targetKey,
    workspaceId,
  ]);

  useEffect(() => {
    processOptimisticSends();
  }, [optimisticSends, processOptimisticSends]);

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
        ...(policyRef.current ? { policy: policyRef.current } : {}),
      };
      if (
        pending.newerShadow.text !== shadow.text ||
        JSON.stringify(pending.newerShadow.resources) !== JSON.stringify(shadow.resources) ||
        JSON.stringify(pending.newerShadow.annotations) !== JSON.stringify(shadow.annotations) ||
        JSON.stringify(pending.newerShadow.policy) !== JSON.stringify(shadow.policy)
      ) {
        pendingOperationRef.current = updatePendingComposerShadow(
          pendingOperationKey,
          pending,
          shadow,
        );
      }
      return;
    }
    const optimistic = optimisticSendsRef.current.at(-1);
    if (optimistic) {
      const shadow = {
        text: valueRef.current,
        resources: mergeResources(
          restoredResourcesRef.current,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
        annotations: annotationsRef.current,
        ...(policyRef.current ? { policy: policyRef.current } : {}),
      };
      if (
        optimistic.newerShadow.text !== shadow.text ||
        JSON.stringify(optimistic.newerShadow.resources) !== JSON.stringify(shadow.resources) ||
        JSON.stringify(optimistic.newerShadow.annotations) !== JSON.stringify(shadow.annotations) ||
        JSON.stringify(optimistic.newerShadow.policy) !== JSON.stringify(shadow.policy)
      ) {
        setOptimisticDraftShadow(shadow);
      }
    }
    if (optimisticSendsRef.current.some((operation) => operation.state === "sending")) {
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
    setOptimisticDraftShadow,
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
      const currentPolicy = policyRef.current;
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
        !currentPolicy ||
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
        if (durableDrafts) {
          const input = operation.input;
          if (
            input.expectedDraftRevision === undefined ||
            input.clientEventId === undefined ||
            input.model === undefined ||
            input.reasoningEffort === undefined ||
            input.latencyMode === undefined
          ) {
            throw new Error("The durable composer draft is not ready for delivery.");
          }
          const result = await client.submitComposerDraft(workspaceId, sessionId, {
            text: input.text,
            annotations: input.annotations ?? [],
            resources: input.resources ?? [],
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            latencyMode: input.latencyMode,
            expectedDraftRevision: input.expectedDraftRevision,
            clientEventId: input.clientEventId,
            delivery: operation.delivery,
            ...(input.controlEtag ? { controlEtag: input.controlEtag } : {}),
            ...(input.modelContext ? { modelContext: input.modelContext } : {}),
            ...(input.mcpCredentialUpdates
              ? { mcpCredentialUpdates: input.mcpCredentialUpdates }
              : {}),
            ...(input.connectionAuthorities
              ? { connectionAuthorities: input.connectionAuthorities }
              : {}),
            ...(input.personalResourceAttachment
              ? { personalResourceAttachment: input.personalResourceAttachment }
              : {}),
          });
          adoptDraftBase(result.draft);
          return result;
        }
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
            if (durableDrafts) await loadDraft(false);
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
            onDeliveryErrorRef.current?.(asError(cause), pending.input, pending.delivery);
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
          ...currentPolicy,
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
            policy: currentPolicy,
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
          onDeliveryErrorRef.current?.(asError(cause), operation.input, operation.delivery);
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
      adoptDraftBase,
      sending,
      sessionId,
      targetKey,
      value,
      workspaceId,
      loadDraft,
    ],
  );

  const send = useCallback(
    async (explicit?: string): Promise<boolean> => {
      if (pendingOperationRef.current?.delivery === "send") {
        return await dispatch("send", explicit);
      }
      const rawText = explicit ?? valueRef.current;
      const annotationsAtSend = cloneAnnotations(annotationsRef.current);
      const currentPolicy = policyRef.current;
      const hasText = rawText.trim().length > 0;
      const hasAnnotations = annotationsAtSend.length > 0;
      const annotationsComplete = annotationsAtSend.every(
        (annotation) => annotation.note.trim().length > 0,
      );
      const extras = resolveSendExtras(sendExtrasRef.current);
      const resources = mergeResources(restoredResourcesRef.current, extras.resources ?? []);
      if (
        !sessionId ||
        !currentPolicy ||
        sending ||
        !annotationsComplete ||
        (!hasText && !hasAnnotations && resources.length === 0) ||
        sendBlockedRef.current?.() === true ||
        targetKeyRef.current !== targetKey
      ) {
        return false;
      }
      const sendText = hasText ? rawText : hasAnnotations ? "" : FILE_ONLY_MESSAGE_TEXT;
      const clientEventId = generateClientEventId();
      const input = composeSendInput(sendText, clientEventId, extras, {
        ...currentPolicy,
        ...(options.effectiveControl?.controlEtag
          ? { controlEtag: options.effectiveControl.controlEtag }
          : {}),
        resources,
        annotations: annotationsAtSend,
      });
      const currentPayload = currentDraftPayload();
      const operation: OptimisticSendOperation = {
        clientEventId,
        text: sendText,
        annotations: annotationsAtSend,
        resources,
        occurredAt: new Date().toISOString(),
        state: "sending",
        input,
        draftPayload: currentPayload ? { ...currentPayload, text: sendText } : null,
        newerShadow: {
          text: explicit === undefined ? "" : valueRef.current,
          resources: explicit === undefined ? [] : [...restoredResourcesRef.current],
          annotations: explicit === undefined ? [] : cloneAnnotations(annotationsRef.current),
          policy: currentPolicy,
        },
        canRetry: true,
      };
      replaceOptimisticSends((current) => [...current, operation]);
      queueMicrotask(processOptimisticSends);
      setError(null);
      onSubmitted?.(sendText, input);
      if (explicit === undefined) {
        valueRef.current = "";
        annotationsRef.current = [];
        restoredResourcesRef.current = [];
        localEditRevision.current += 1;
        setValue("");
        setAnnotations([]);
        setAnnotationReviewTargetId(null);
        setRestoredResources([]);
      }
      return true;
    },
    [
      currentDraftPayload,
      dispatch,
      onSubmitted,
      options.effectiveControl?.controlEtag,
      processOptimisticSends,
      replaceOptimisticSends,
      sending,
      sessionId,
      targetKey,
    ],
  );
  const steer = useCallback(async (text?: string) => await dispatch("steer", text), [dispatch]);

  const retryOptimisticMessage = useCallback(
    (clientEventId: string): void => {
      if (sendBlockedRef.current?.() === true) return;
      replaceOptimisticSends((current) =>
        current.map((operation) => {
          if (operation.clientEventId !== clientEventId || operation.state !== "failed") {
            return operation;
          }
          if (operation.outcomeUnknown) {
            return { ...operation, state: "sending", error: undefined };
          }
          const nextClientEventId = generateClientEventId();
          const currentPersonalResourceAttachment = resolveSendExtras(
            sendExtrasRef.current,
          ).personalResourceAttachment;
          const retryInput = composeSendInput(
            operation.text,
            nextClientEventId,
            {
              ...operation.input,
              ...(currentPersonalResourceAttachment
                ? { personalResourceAttachment: currentPersonalResourceAttachment }
                : {}),
            },
            {
              ...(options.effectiveControl?.controlEtag
                ? { controlEtag: options.effectiveControl.controlEtag }
                : {}),
              resources: operation.resources,
              annotations: operation.annotations,
            },
          );
          return {
            ...operation,
            clientEventId: nextClientEventId,
            input: retryInput,
            draftPayload: operation.draftPayload,
            occurredAt: new Date().toISOString(),
            state: "sending",
            error: undefined,
            outcomeUnknown: false,
            canRetry: true,
          };
        }),
      );
      queueMicrotask(processOptimisticSends);
    },
    [options.effectiveControl?.controlEtag, processOptimisticSends, replaceOptimisticSends],
  );

  const removeOptimisticMessage = useCallback(
    (clientEventId: string): void => {
      replaceOptimisticSends((current) =>
        current.filter((operation) => operation.clientEventId !== clientEventId),
      );
    },
    [replaceOptimisticSends],
  );

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
          policy: policyRef.current ?? undefined,
        },
      );
      setOptimisticDraftShadow({
        text: next,
        resources: mergeResources(
          restoredResourcesRef.current,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
        annotations: annotationsRef.current,
        policy: policyRef.current ?? undefined,
      });
      setValue(next);
    },
    [pendingOperationKey, setOptimisticDraftShadow, targetKey],
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
          policy: policyRef.current ?? undefined,
        },
      );
      setOptimisticDraftShadow({
        text: valueRef.current,
        resources: mergeResources(
          restoredResourcesRef.current,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
        annotations: next,
        policy: policyRef.current ?? undefined,
      });
      setAnnotations(next);
      setAnnotationReviewTargetId(reviewTargetId);
    },
    [pendingOperationKey, setOptimisticDraftShadow, targetKey],
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

  const updatePolicy = useCallback(
    (next: ComposerPolicy): void => {
      if (targetKeyRef.current !== targetKey) return;
      localEditRevision.current += 1;
      policyRef.current = next;
      const shadow = {
        text: valueRef.current,
        resources: mergeResources(
          restoredResourcesRef.current,
          resolveSendExtras(sendExtrasRef.current).resources ?? [],
        ),
        annotations: annotationsRef.current,
        policy: next,
      };
      pendingOperationRef.current = updatePendingComposerShadow(
        pendingOperationKey,
        pendingOperationRef.current,
        shadow,
      );
      setOptimisticDraftShadow(shadow);
      setPolicy(next);
    },
    [pendingOperationKey, setOptimisticDraftShadow, targetKey],
  );

  const updateModel = useCallback(
    (model: string): void => {
      const current = policyRef.current;
      if (current) updatePolicy({ ...current, model });
    },
    [updatePolicy],
  );

  const updateReasoningEffort = useCallback(
    (reasoningEffort: ReasoningEffort): void => {
      const current = policyRef.current;
      if (current) updatePolicy({ ...current, reasoningEffort });
    },
    [updatePolicy],
  );

  const updateLatencyMode = useCallback(
    (latencyMode: LatencyMode): void => {
      const current = policyRef.current;
      if (current) updatePolicy({ ...current, latencyMode });
    },
    [updatePolicy],
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
          annotations: annotationsRef.current,
          policy: policyRef.current ?? undefined,
        },
      );
      setOptimisticDraftShadow({
        text: valueRef.current,
        resources: mergeResources(next, resolveSendExtras(sendExtrasRef.current).resources ?? []),
        annotations: annotationsRef.current,
        policy: policyRef.current ?? undefined,
      });
      setRestoredResources(next);
    },
    [pendingOperationKey, setOptimisticDraftShadow, targetKey],
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
    optimisticMessages: identityMatches
      ? optimisticSends.map(
          ({ input: _input, draftPayload: _payload, canRetry: _retry, ...item }) => item,
        )
      : [],
    retryOptimisticMessage,
    removeOptimisticMessage,
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
      !draftLoading &&
      policy !== null &&
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
    policy: identityMatches ? policy : null,
    setModel: updateModel,
    setReasoningEffort: updateReasoningEffort,
    setLatencyMode: updateLatencyMode,
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
 * Default text for a resource-only message (attachments present, no typed
 * draft). Kept non-empty so the wire contract (`text: z.string().min(1)`) and
 * the worker's non-whitespace guard accept it. The export name is retained for
 * compatibility now that repositories can ride beside files in `resources`.
 */
export const FILE_ONLY_MESSAGE_TEXT = "(see attached context)";

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
    apiError.status === 409 && apiError.outcomeUnknown !== true && apiError.code === "DRAFT_CHANGED"
  );
}

function draftPayload(draft: ComposerDraft): SaveComposerDraftRequest {
  return {
    expectedRevision: draft.revision,
    text: draft.text,
    resources: draft.resources,
    annotations: draft.annotations ?? [],
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
  };
}

function policyFromDraft(draft: ComposerDraft): ComposerPolicy {
  return {
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
  };
}

function composerDraftPayload(
  base: ComposerDraft,
  text: string,
  restoredResources: ResourceRef[],
  annotations: DraftTimelineAnnotation[],
  policy: ComposerPolicy,
  additionalResources: ResourceRef[],
): SaveComposerDraftRequest {
  return {
    expectedRevision: base.revision,
    text,
    resources: mergeResources(restoredResources, additionalResources),
    annotations,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    latencyMode: policy.latencyMode,
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
