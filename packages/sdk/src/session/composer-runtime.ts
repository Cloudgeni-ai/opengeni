import type { SendMessageInput } from "../client";
import { OpenGeniApiError } from "../errors";
import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  type ComposerDraft,
  type DraftTimelineAnnotation,
  type EffectiveControlResumeOption,
  type EffectiveSessionControl,
  type LatencyMode,
  type ReasoningEffort,
  type ResourceRef,
  type SaveComposerDraftRequest,
  type SessionEvent,
  type SessionPromptRouting,
  type SubmitComposerDraftResponse,
} from "../types";
import type { SessionClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  composeSessionMessageInput,
  FILE_ONLY_MESSAGE_TEXT,
  isComposerDraftEvent,
  type SessionComposerSendExtras,
} from "./composer";
import { asError, isOutcomeUnknownError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export type SessionComposerPolicy = Readonly<{
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
}>;

export type SessionComposerOptimisticMessage = Readonly<{
  clientEventId: string;
  delivery: "send" | "steer";
  destination: "chat" | "queue";
  text: string;
  annotations: readonly DraftTimelineAnnotation[];
  resources: readonly ResourceRef[];
  occurredAt: string;
  state: "sending" | "queued" | "failed";
  turnId?: string | null | undefined;
  triggerEventId?: string | null | undefined;
  appliedQueueVersion?: number | null | undefined;
  error?: string | undefined;
  outcomeUnknown?: boolean | undefined;
}>;

export type SessionComposerSteeringState = Readonly<{
  phase: "submitting" | "accepted" | "failed";
  text: string;
  clientEventId: string | null;
  triggerEventId: string | null;
  turnId: string | null;
  stoppingPreviousAttempt?: boolean | undefined;
  error?: string | undefined;
  outcomeUnknown?: boolean | undefined;
}>;

export type SessionComposerRuntimeSnapshot = Readonly<{
  value: string;
  /** Svelte-compatible alias for value. */
  text: string;
  annotations: readonly DraftTimelineAnnotation[];
  annotationReviewTargetId: string | null;
  optimisticMessages: readonly SessionComposerOptimisticMessage[];
  steering: SessionComposerSteeringState | null;
  stoppingAttempt: "current" | "previous" | null;
  sending: boolean;
  /** Svelte-compatible alias for sending. */
  submitting: boolean;
  canSend: boolean;
  pausing: boolean;
  resuming: boolean;
  effectiveControl: EffectiveSessionControl | null;
  draft: ComposerDraft | null;
  draftRevision: number;
  draftLoading: boolean;
  /** Svelte-compatible alias for draftLoading. */
  loading: boolean;
  draftSaving: boolean;
  /** Svelte-compatible alias for draftSaving. */
  saving: boolean;
  draftConflict: Error | null;
  policy: SessionComposerPolicy | null;
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
  draftPersistence: "durable" | "disabled";
  restoredResources: readonly ResourceRef[];
  /** Svelte-compatible alias for restoredResources. */
  resources: readonly ResourceRef[];
  dirty: boolean;
  error: Error | null;
  /** Svelte-compatible alias for error. */
  mutationError: Error | null;
  lastRouting: SessionPromptRouting | null;
}>;

export type SessionComposerRuntimeOptions = {
  client: Pick<
    SessionClientLike,
    | "getSession"
    | "listEvents"
    | "streamEvents"
    | "getComposerDraft"
    | "saveComposerDraft"
    | "submitComposerDraft"
    | "sendMessage"
    | "steerMessage"
    | "getQueue"
    | "pauseSession"
    | "resumeSession"
  > &
    Pick<SessionClientLike, "setWorkspaceInferenceState">;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean | undefined;
  draftPersistence?: "durable" | "disabled" | undefined;
  initialPolicy?: SessionComposerPolicy | undefined;
  events?: readonly SessionEvent[] | undefined;
  sendExtras?: SessionComposerSendExtras | (() => SessionComposerSendExtras) | undefined;
  sendBlocked?: (() => boolean) | undefined;
  effectiveControl?: EffectiveSessionControl | null | undefined;
  sendDestination?: (() => "chat" | "queue") | undefined;
  onSubmitted?: ((text: string, input: SendMessageInput) => void) | undefined;
  onSent?: ((text: string, input: SendMessageInput) => void) | undefined;
  onDeliveryError?:
    | ((error: Error, input: SendMessageInput, delivery: "send" | "steer") => void)
    | undefined;
  autosaveDelayMs?: number | undefined;
  hiddenGraceMs?: number | undefined;
  environment?: SessionRuntimeEnvironment | undefined;
};

export type SessionComposerRuntimeStore = OpenGeniExternalStore<SessionComposerRuntimeSnapshot> & {
  applyEvents(events: readonly SessionEvent[]): void;
  syncExternalInputs(): void;
  setEffectiveControl(control: EffectiveSessionControl | null | undefined): void;
  setValue(value: string): void;
  setText(value: string): void;
  setAnnotations(annotations: readonly DraftTimelineAnnotation[]): void;
  addAnnotation(annotation: DraftTimelineAnnotation): void;
  updateAnnotation(id: string, note: string): void;
  removeAnnotation(id: string): void;
  clearAnnotationReviewTarget(): void;
  setResources(resources: readonly ResourceRef[]): void;
  removeRestoredResource(index: number): void;
  setModel(model: string): void;
  setReasoningEffort(effort: ReasoningEffort): void;
  setLatencyMode(mode: LatencyMode): void;
  hasDraftContent(): boolean;
  send(text?: string): Promise<boolean>;
  steer(text?: string): Promise<boolean>;
  submit(
    delivery?: "send" | "steer",
    extras?: SessionComposerSendExtras,
  ): Promise<SubmitComposerDraftResponse | null>;
  retryOptimisticMessage(clientEventId: string): void;
  removeOptimisticMessage(clientEventId: string): void;
  pause(reason?: string): Promise<void>;
  resume(reason?: string): Promise<void>;
  resumeScope(option: EffectiveControlResumeOption): Promise<void>;
  applyDraft(draft: ComposerDraft): void;
  replaceDraft(draft: ComposerDraft): void;
  refresh(): Promise<void>;
  reloadDraft(): Promise<void>;
  saveNow(): Promise<ComposerDraft | null>;
  resolveDraftConflict(choice: "keep_mine" | "use_remote"): Promise<void>;
  clearError(): void;
  clearMutationError(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

type ComposerDraftShadow = {
  text: string;
  resources: ResourceRef[];
  annotations: DraftTimelineAnnotation[];
  policy?: SessionComposerPolicy | undefined;
};

type PendingComposerOperation = {
  delivery: "send" | "steer";
  input: SendMessageInput;
  draftAtSend: string;
  resourcesAtSend: ResourceRef[];
  annotationsAtSend: DraftTimelineAnnotation[];
  newerShadow: ComposerDraftShadow;
  clearDraftOnAccept: boolean;
  canRetry: boolean;
};

type StoredPendingComposerOperation = Omit<PendingComposerOperation, "input" | "canRetry"> & {
  input: Omit<SendMessageInput, "mcpCredentialUpdates">;
  hasMcpCredentialUpdates: boolean;
};

type OptimisticSendOperation = SessionComposerOptimisticMessage & {
  annotations: DraftTimelineAnnotation[];
  resources: ResourceRef[];
  input: SendMessageInput;
  draftPayload: SaveComposerDraftRequest | null;
  newerShadow: ComposerDraftShadow;
  canRetry: boolean;
};

type StoredOptimisticSendOperation = Omit<OptimisticSendOperation, "input" | "canRetry"> & {
  input: Omit<SendMessageInput, "mcpCredentialUpdates">;
  hasMcpCredentialUpdates: boolean;
};

const PENDING_COMPOSER_STORAGE_PREFIX = "opengeni.pending-composer.v1:";
const OPTIMISTIC_SEND_STORAGE_PREFIX = "opengeni.optimistic-sends.v1:";
const pendingComposerOperations = new Map<string, StoredPendingComposerOperation>();
const optimisticSendOperations = new Map<string, StoredOptimisticSendOperation[]>();

const STEERING_SETTLEMENT_EVENT_TYPES = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

function pendingComposerOperationKey(
  workspaceId: string,
  sessionId: string | null | undefined,
): string | null {
  return sessionId ? `${workspaceId}\u0000${sessionId}` : null;
}

function pendingComposerStorageKey(key: string): string {
  return `${PENDING_COMPOSER_STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function optimisticSendStorageKey(key: string): string {
  return `${OPTIMISTIC_SEND_STORAGE_PREFIX}${encodeURIComponent(key)}`;
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

function clonePolicy(policy: SessionComposerPolicy | undefined): SessionComposerPolicy | undefined {
  return policy ? { ...policy } : undefined;
}

function cloneShadow(shadow: ComposerDraftShadow): ComposerDraftShadow {
  return {
    text: shadow.text,
    resources: [...shadow.resources],
    annotations: cloneAnnotations(shadow.annotations),
    ...(shadow.policy ? { policy: { ...shadow.policy } } : {}),
  };
}

function readStoredPendingComposerOperation(
  key: string | null,
  environment: SessionRuntimeEnvironment,
): StoredPendingComposerOperation | null {
  const storage = key ? environment.draftStorage : undefined;
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

function restorePendingComposerOperation(
  key: string | null,
  environment: SessionRuntimeEnvironment,
): PendingComposerOperation | null {
  const stored =
    (key && pendingComposerOperations.get(key)) ??
    readStoredPendingComposerOperation(key, environment);
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
  environment: SessionRuntimeEnvironment,
): void {
  if (!key) return;
  const { canRetry: _retry, ...safeOperation } = operation;
  const { input: originalInput, ...withoutInput } = safeOperation;
  const { mcpCredentialUpdates: _storedMcp, ...safeInput } = originalInput;
  const stored = {
    ...withoutInput,
    input: safeInput,
    hasMcpCredentialUpdates: operation.input.mcpCredentialUpdates !== undefined,
    newerShadow: cloneShadow(operation.newerShadow),
  } satisfies StoredPendingComposerOperation;
  pendingComposerOperations.set(key, stored);
  try {
    environment.draftStorage?.setItem(pendingComposerStorageKey(key), JSON.stringify(stored));
  } catch {
    // Storage is best effort; the process-local journal remains authoritative for this mount.
  }
}

function forgetPendingComposerOperation(
  key: string | null,
  environment: SessionRuntimeEnvironment,
): void {
  if (!key) return;
  pendingComposerOperations.delete(key);
  try {
    environment.draftStorage?.removeItem(pendingComposerStorageKey(key));
  } catch {
    // Delivery has already settled; a blocked storage implementation is non-fatal.
  }
}

function updatePendingComposerShadow(
  key: string | null,
  operation: PendingComposerOperation | null,
  shadow: ComposerDraftShadow,
  environment: SessionRuntimeEnvironment,
): PendingComposerOperation | null {
  if (!key || !operation) return operation;
  const next = { ...operation, newerShadow: cloneShadow(shadow) };
  rememberPendingComposerOperation(key, next, environment);
  return next;
}

function restoreOptimisticSendOperations(
  key: string | null,
  environment: SessionRuntimeEnvironment,
): OptimisticSendOperation[] {
  if (!key) return [];
  let stored = optimisticSendOperations.get(key);
  if (!stored) {
    try {
      const parsed: unknown = JSON.parse(
        environment.draftStorage?.getItem(optimisticSendStorageKey(key)) ?? "[]",
      );
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
    annotations: cloneAnnotations(operation.annotations ?? []),
    resources: [...(operation.resources ?? [])],
    delivery: "send",
    destination: operation.destination === "queue" ? "queue" : "chat",
    newerShadow: cloneShadow(operation.newerShadow ?? { text: "", resources: [], annotations: [] }),
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
  environment: SessionRuntimeEnvironment,
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
  if (stored.length === 0) {
    optimisticSendOperations.delete(key);
    try {
      environment.draftStorage?.removeItem(optimisticSendStorageKey(key));
    } catch {
      // The process-local journal is already clear.
    }
    return;
  }
  optimisticSendOperations.set(key, stored);
  try {
    environment.draftStorage?.setItem(optimisticSendStorageKey(key), JSON.stringify(stored));
  } catch {
    // The process-local journal still owns this mount.
  }
}

function isSteeringSettlementEvent(event: Pick<SessionEvent, "type">): boolean {
  return STEERING_SETTLEMENT_EVENT_TYPES.has(event.type);
}

function steeringAcceptedEvent(
  steering: SessionComposerSteeringState,
  events: readonly SessionEvent[],
): SessionEvent | undefined {
  return events.find(
    (event) =>
      event.type === "user.message" &&
      steering.clientEventId !== null &&
      event.clientEventId === steering.clientEventId,
  );
}

function promptTurnIdForTrigger(
  triggerEventId: string | null | undefined,
  events: readonly SessionEvent[],
): string | null {
  if (!triggerEventId) return null;
  const queued = events.find((event) => {
    if (event.type !== "turn.queued") return false;
    const payload = event.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "triggerEventId" in payload &&
      payload.triggerEventId === triggerEventId
    );
  });
  if (!queued) return null;
  if (queued.turnId) return queued.turnId;
  const payload = queued.payload;
  return typeof payload === "object" &&
    payload !== null &&
    "turnId" in payload &&
    typeof payload.turnId === "string"
    ? payload.turnId
    : null;
}

function steeringSettledByEvents(
  steering: SessionComposerSteeringState,
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

function promptRoutingFromAcceptedEvent(
  event: SessionEvent | null,
): "accepted_for_execution" | "queued_for_execution" | "accepted_for_steering" | null {
  if (
    typeof event?.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const routing = (event.payload as Record<string, unknown>).routing;
  return routing === "accepted_for_execution" ||
    routing === "queued_for_execution" ||
    routing === "accepted_for_steering"
    ? routing
    : null;
}

function reconcileOptimisticSendFromEvents(
  operation: OptimisticSendOperation,
  events: readonly SessionEvent[],
): { operation: OptimisticSendOperation; admitted: boolean; settled: boolean } {
  const accepted = events.find(
    (event) => event.type === "user.message" && event.clientEventId === operation.clientEventId,
  );
  const triggerEventId = operation.triggerEventId ?? accepted?.id ?? null;
  const turnId = operation.turnId ?? promptTurnIdForTrigger(triggerEventId, events);
  const acceptedRouting = promptRoutingFromAcceptedEvent(accepted ?? null);
  const destination =
    acceptedRouting === "queued_for_execution"
      ? "queue"
      : acceptedRouting === "accepted_for_execution" || acceptedRouting === "accepted_for_steering"
        ? "chat"
        : operation.destination;
  const needsAdmissionUpdate =
    accepted !== undefined &&
    (operation.state !== "queued" ||
      operation.destination !== destination ||
      operation.triggerEventId !== triggerEventId ||
      operation.turnId !== turnId ||
      operation.error !== undefined ||
      operation.outcomeUnknown !== false);
  const reconciled: OptimisticSendOperation = needsAdmissionUpdate
    ? {
        ...operation,
        state: "queued",
        destination,
        triggerEventId,
        turnId,
        error: undefined,
        outcomeUnknown: false,
      }
    : operation;
  const withdrawnFromQueue = events.some((event) => {
    if (event.type !== "session.queue.changed" || !turnId) return false;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    return (
      record.turnId === turnId && (record.operation === "edit" || record.operation === "delete")
    );
  });
  return {
    operation: reconciled,
    admitted: accepted !== undefined,
    settled:
      withdrawnFromQueue ||
      steeringSettledByEvents(
        {
          phase: "accepted",
          text: reconciled.text,
          clientEventId: reconciled.clientEventId,
          triggerEventId: reconciled.triggerEventId ?? null,
          turnId: reconciled.turnId ?? null,
        },
        events,
      ),
  };
}

function resolveSendExtras(
  extras: SessionComposerRuntimeOptions["sendExtras"],
): SessionComposerSendExtras {
  return typeof extras === "function" ? extras() : (extras ?? {});
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

function policyFromDraft(draft: ComposerDraft): SessionComposerPolicy {
  return {
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
  };
}

function composerDraftPayload(
  base: ComposerDraft,
  text: string,
  restoredResources: readonly ResourceRef[],
  annotations: readonly DraftTimelineAnnotation[],
  policy: SessionComposerPolicy,
  additionalResources: readonly ResourceRef[],
): SaveComposerDraftRequest {
  return {
    expectedRevision: base.revision,
    text,
    resources: mergeResources(restoredResources, additionalResources),
    annotations: cloneAnnotations(annotations),
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    latencyMode: policy.latencyMode,
  };
}

function draftSignature(payload: SaveComposerDraftRequest): string {
  const { expectedRevision: _revision, ...content } = payload;
  return JSON.stringify(content);
}

function mergeResources(
  base: readonly ResourceRef[],
  additions: readonly ResourceRef[],
): ResourceRef[] {
  const seen = new Set<string>();
  return [...base, ...additions].filter((resource) => {
    const key =
      resource.kind === "file"
        ? `file:${resource.fileId}\u0000${resource.mountPath ?? `${DEFAULT_FILE_RESOURCE_MOUNT_ROOT}/${resource.fileId}`}`
        : JSON.stringify(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function replayOutcomeUnknown<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (cause) {
    if (!isOutcomeUnknownError(cause)) throw cause;
    return await operation();
  }
}

export function createSessionComposerRuntimeStore(
  options: SessionComposerRuntimeOptions,
): SessionComposerRuntimeStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const durableDrafts = options.draftPersistence !== "disabled";
  if (!durableDrafts && !options.initialPolicy) {
    throw new Error("A composer requires initialPolicy when draft persistence is disabled");
  }
  const sharedFeed = options.events !== undefined;
  const operationKey = pendingComposerOperationKey(options.workspaceId, sessionId);
  let pendingOperation = restorePendingComposerOperation(operationKey, environment);
  let optimisticSends = restoreOptimisticSendOperations(operationKey, environment);
  const initialShadow = pendingOperation?.newerShadow ?? optimisticSends.at(-1)?.newerShadow;
  let value = initialShadow?.text ?? "";
  let annotations = cloneAnnotations(initialShadow?.annotations ?? []);
  let annotationReviewTargetId: string | null = null;
  let steering: SessionComposerSteeringState | null =
    pendingOperation?.delivery === "steer"
      ? {
          phase: "failed",
          text: pendingOperation.input.text,
          clientEventId: pendingOperation.input.clientEventId ?? null,
          triggerEventId: null,
          turnId: null,
          error: "Not confirmed. Retry to check the same direction change.",
          outcomeUnknown: true,
        }
      : null;
  let steeringOccurredAt = new Date(environment.clock.now()).toISOString();
  let sending = false;
  let pausing = false;
  let resuming = false;
  let acceptedControl: EffectiveSessionControl | null = null;
  let suppliedEffectiveControl = options.effectiveControl ?? null;
  let draft: ComposerDraft | null = null;
  let draftLoading = enabled && durableDrafts;
  let draftSaving = false;
  let draftConflict: Error | null = null;
  let policy = clonePolicy(initialShadow?.policy ?? options.initialPolicy);
  let restoredResources = [...(initialShadow?.resources ?? [])];
  let error: Error | null = null;
  let lastRouting: SessionPromptRouting | null = null;
  let lastSubmitResponse: SubmitComposerDraftResponse | null = null;
  let localEditRevision = initialShadow ? 1 : 0;
  let generation = 0;
  let readGeneration = 0;
  let readInFlight: { promise: Promise<void>; controller: AbortController; ticket: number } | null =
    null;
  let readRetry: { failures: number; timer: unknown } = { failures: 0, timer: undefined };
  let lastSavedSignature: string | null = null;
  let saveChain = Promise.resolve();
  let autosaveTimer: unknown;
  let optimisticProcessorBusy = false;
  const optimisticCallbackIds = new Set<string>();
  let pendingClientEventId = pendingOperation?.input.clientEventId ?? null;
  let latestEvents = options.events ?? [];
  let sharedFeedInitialized = false;
  let sharedFeedHasEvents = false;
  let consumedSequence = 0;
  let pageLive = true;
  let hiddenTimer: unknown;
  let visibilityUnsubscribe: (() => void) | undefined;
  let streamGeneration = 0;
  let streamAbort: AbortController | null = null;
  let streamIterator: AsyncIterator<SessionEvent> | null = null;
  let lastExtrasVersion = JSON.stringify(resolveSendExtras(options.sendExtras));
  let lastSendBlocked = options.sendBlocked?.() === true;
  let suppliedEffectiveControlVersion = JSON.stringify(suppliedEffectiveControl);

  const store = createExternalStore<SessionComposerRuntimeSnapshot>({
    initialSnapshot: {} as SessionComposerRuntimeSnapshot,
    start: async () => {
      if (!enabled) {
        draftLoading = false;
        publish();
        return;
      }
      if (environment.visibility) {
        visibilityUnsubscribe = environment.visibility.subscribe(syncVisibility);
        store.trackListener(1);
        syncVisibility();
      }
      processSharedEvents(latestEvents);
      if (durableDrafts) await loadDraft(false);
      if (!sharedFeed && (durableDrafts || steering !== null)) startStream();
      processOptimisticSends();
    },
    destroy: () => {
      generation += 1;
      readGeneration += 1;
      readInFlight?.controller.abort();
      readInFlight = null;
      clearReadRetry();
      clearAutosave();
      clearHiddenTimer();
      stopStream();
      if (visibilityUnsubscribe) {
        visibilityUnsubscribe();
        visibilityUnsubscribe = undefined;
        store.trackListener(-1);
      }
    },
  });

  function currentEffectiveControl(): EffectiveSessionControl | null {
    return acceptedControl ?? suppliedEffectiveControl;
  }

  function currentExtras(override?: SessionComposerSendExtras): SessionComposerSendExtras {
    return override ?? resolveSendExtras(options.sendExtras);
  }

  function currentDraftPayload(): SaveComposerDraftRequest | null {
    if (!durableDrafts || !draft || !policy) return null;
    return composerDraftPayload(
      draft,
      value,
      restoredResources,
      annotations,
      policy,
      currentExtras().resources ?? [],
    );
  }

  function isDirty(): boolean {
    const payload = currentDraftPayload();
    return payload !== null && draftSignature(payload) !== lastSavedSignature;
  }

  function publicOptimisticMessages(): SessionComposerOptimisticMessage[] {
    const ordinary = optimisticSends.map(
      ({
        input: _input,
        draftPayload: _payload,
        canRetry: _retry,
        newerShadow: _shadow,
        ...item
      }) => item,
    );
    if (!steering?.clientEventId) return ordinary;
    return [
      ...ordinary,
      {
        clientEventId: steering.clientEventId,
        delivery: "steer",
        destination: "chat",
        text: steering.text,
        annotations:
          pendingOperation?.delivery === "steer"
            ? cloneAnnotations(pendingOperation.annotationsAtSend)
            : [],
        resources:
          pendingOperation?.delivery === "steer" ? [...pendingOperation.resourcesAtSend] : [],
        occurredAt: steeringOccurredAt,
        state:
          steering.phase === "submitting"
            ? "sending"
            : steering.phase === "failed"
              ? "failed"
              : "queued",
        turnId: steering.turnId,
        triggerEventId: steering.triggerEventId,
        ...(steering.error ? { error: steering.error } : {}),
        ...(steering.outcomeUnknown === undefined
          ? {}
          : { outcomeUnknown: steering.outcomeUnknown }),
      },
    ];
  }

  function canSend(): boolean {
    const extras = currentExtras();
    const hasReadyResources = restoredResources.length > 0 || (extras.resources?.length ?? 0) > 0;
    const annotationsComplete = annotations.every(
      (annotation) => annotation.note.trim().length > 0,
    );
    return (
      enabled &&
      !sending &&
      !draftLoading &&
      policy !== null &&
      options.sendBlocked?.() !== true &&
      annotationsComplete &&
      (pendingOperation !== null ||
        value.trim().length > 0 ||
        hasReadyResources ||
        annotations.length > 0)
    );
  }

  function snapshot(): SessionComposerRuntimeSnapshot {
    const optimisticMessages = publicOptimisticMessages();
    return {
      value,
      text: value,
      annotations: cloneAnnotations(annotations),
      annotationReviewTargetId,
      optimisticMessages,
      steering,
      stoppingAttempt:
        steering?.phase === "accepted" && steering.stoppingPreviousAttempt === true
          ? "previous"
          : null,
      sending,
      submitting: sending,
      canSend: canSend(),
      pausing,
      resuming,
      effectiveControl: currentEffectiveControl(),
      draft,
      draftRevision: draft?.revision ?? 0,
      draftLoading,
      loading: draftLoading,
      draftSaving,
      saving: draftSaving,
      draftConflict,
      policy: policy ? { ...policy } : null,
      model: policy?.model ?? "",
      reasoningEffort: policy?.reasoningEffort ?? "medium",
      latencyMode: policy?.latencyMode ?? "standard",
      draftPersistence: durableDrafts ? "durable" : "disabled",
      restoredResources: [...restoredResources],
      resources: [...restoredResources],
      dirty: isDirty(),
      error,
      mutationError: error,
      lastRouting,
    };
  }

  function publish(): void {
    store.publish(snapshot());
  }

  function clearReadRetry(): void {
    if (readRetry.timer !== undefined) {
      environment.clock.clearTimeout(readRetry.timer);
      readRetry.timer = undefined;
      store.trackTimer(-1);
    }
    readRetry.failures = 0;
  }

  function scheduleReadRetry(): void {
    if (readRetry.timer !== undefined || store.signal.aborted) return;
    const jitter = 0.8 + (environment.random?.() ?? 0.5) * 0.4;
    const delay = Math.min(25_000, 1_000 * 2 ** Math.max(0, readRetry.failures - 1)) * jitter;
    store.trackTimer(1);
    readRetry.timer = environment.clock.setTimeout(() => {
      readRetry.timer = undefined;
      store.trackTimer(-1);
      void loadDraft(false);
    }, delay);
  }

  async function loadDraft(replaceLocal: boolean): Promise<void> {
    if (!enabled || !durableDrafts || store.signal.aborted) {
      draftLoading = false;
      publish();
      return;
    }
    if (!replaceLocal && readRetry.timer !== undefined) return;
    if (readInFlight) return readInFlight.promise;
    if (readRetry.timer !== undefined) {
      environment.clock.clearTimeout(readRetry.timer);
      readRetry.timer = undefined;
      store.trackTimer(-1);
    }
    const ownedGeneration = generation;
    const ticket = ++readGeneration;
    const controller = new AbortController();
    const localAtStart = localEditRevision;
    const baseAtStart = draft;
    const policyAtStart = policy;
    const localSignatureAtStart =
      baseAtStart && policyAtStart
        ? draftSignature(
            composerDraftPayload(
              baseAtStart,
              value,
              restoredResources,
              annotations,
              policyAtStart,
              currentExtras().resources ?? [],
            ),
          )
        : null;
    const localWasDirtyAtStart =
      localSignatureAtStart === null
        ? localAtStart !== 0
        : localSignatureAtStart !== lastSavedSignature;
    if (replaceLocal || draft === null) {
      draftLoading = true;
      publish();
    }
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const fetched = await store.trackRead(() =>
          options.client.getComposerDraft(options.workspaceId, sessionId, {
            signal: controller.signal,
          }),
        );
        if (
          ownedGeneration !== generation ||
          ticket !== readGeneration ||
          controller.signal.aborted ||
          store.signal.aborted
        ) {
          return;
        }
        clearReadRetry();
        const currentRevision = draft?.revision ?? -1;
        if (replaceLocal || fetched.revision > currentRevision) {
          draft = fetched;
          draftConflict = null;
          const shadow = pendingOperation?.newerShadow ?? optimisticSends.at(-1)?.newerShadow;
          if (shadow) {
            value = shadow.text;
            restoredResources = [...shadow.resources];
            annotations = cloneAnnotations(shadow.annotations);
            if (shadow.policy) policy = { ...shadow.policy };
            localEditRevision ||= 1;
          } else if (
            replaceLocal ||
            (!localWasDirtyAtStart && localAtStart === localEditRevision)
          ) {
            value = fetched.text;
            restoredResources = [...fetched.resources];
            annotations = cloneAnnotations(fetched.annotations ?? []);
            policy = policyFromDraft(fetched);
            lastSavedSignature = draftSignature(draftPayload(fetched));
          } else {
            lastSavedSignature = draftSignature(draftPayload(fetched));
            if (!policy) policy = policyFromDraft(fetched);
          }
        }
      } catch (cause) {
        if (
          ownedGeneration === generation &&
          ticket === readGeneration &&
          !controller.signal.aborted &&
          !store.signal.aborted
        ) {
          error = asError(cause);
          if (
            cause instanceof TypeError ||
            (cause && typeof cause === "object" && "retryable" in cause && cause.retryable === true)
          ) {
            readRetry.failures += 1;
            scheduleReadRetry();
          } else {
            clearReadRetry();
          }
        }
      } finally {
        if (ownedGeneration === generation && ticket === readGeneration && !store.signal.aborted) {
          draftLoading = false;
          publish();
          syncShadowAndAutosave();
        }
        if (
          (
            readInFlight as {
              promise: Promise<void>;
              controller: AbortController;
              ticket: number;
            } | null
          )?.ticket === ticket
        ) {
          readInFlight = null;
        }
      }
    })();
    readInFlight = { promise, controller, ticket };
    return promise;
  }

  function adoptDraftBase(next: ComposerDraft): void {
    if (store.signal.aborted) return;
    draft = next;
    lastSavedSignature = draftSignature(draftPayload(next));
    draftConflict = null;
    error = null;
    publish();
  }

  async function persistPayload(payload: SaveComposerDraftRequest): Promise<boolean> {
    if (!enabled || !durableDrafts || store.signal.aborted) return false;
    const ownedGeneration = generation;
    let success = false;
    const run = async () => {
      if (ownedGeneration !== generation || store.signal.aborted || !draft) return;
      const request = { ...payload, expectedRevision: draft.revision };
      const signature = draftSignature(request);
      if (signature === lastSavedSignature) {
        success = true;
        return;
      }
      draftSaving = true;
      publish();
      try {
        const saved = await options.client.saveComposerDraft(
          options.workspaceId,
          sessionId,
          request,
        );
        if (ownedGeneration !== generation || store.signal.aborted) return;
        adoptDraftBase(saved);
        success = true;
      } catch (cause) {
        if (ownedGeneration !== generation || store.signal.aborted) return;
        const problem = asError(cause);
        if (isDraftConflictError(problem)) draftConflict = problem;
        error = problem;
      } finally {
        if (ownedGeneration === generation && !store.signal.aborted) {
          draftSaving = false;
          publish();
        }
      }
    };
    saveChain = saveChain.then(run, run);
    await saveChain;
    return success;
  }

  function clearAutosave(): void {
    if (autosaveTimer === undefined) return;
    environment.clock.clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    store.trackTimer(-1);
  }

  function scheduleAutosave(): void {
    clearAutosave();
    if (
      !enabled ||
      !durableDrafts ||
      draftLoading ||
      sending ||
      !draft ||
      draftConflict ||
      optimisticSends.some((operation) => operation.state === "sending") ||
      pendingOperation ||
      store.signal.aborted
    ) {
      return;
    }
    const payload = currentDraftPayload();
    if (!payload || draftSignature(payload) === lastSavedSignature) return;
    store.trackTimer(1);
    autosaveTimer = environment.clock.setTimeout(() => {
      autosaveTimer = undefined;
      store.trackTimer(-1);
      void persistPayload(payload);
    }, options.autosaveDelayMs ?? 500);
  }

  function currentShadow(): ComposerDraftShadow {
    return {
      text: value,
      resources: mergeResources(restoredResources, currentExtras().resources ?? []),
      annotations: cloneAnnotations(annotations),
      ...(policy ? { policy: { ...policy } } : {}),
    };
  }

  function replaceOptimisticSends(
    update: (current: OptimisticSendOperation[]) => OptimisticSendOperation[],
    shouldPublish = true,
  ): OptimisticSendOperation[] {
    optimisticSends = update(optimisticSends);
    rememberOptimisticSendOperations(operationKey, optimisticSends, environment);
    if (shouldPublish) publish();
    return optimisticSends;
  }

  function setOptimisticDraftShadow(shadow: ComposerDraftShadow): void {
    if (optimisticSends.length === 0) return;
    replaceOptimisticSends(
      (current) => current.map((operation) => ({ ...operation, newerShadow: cloneShadow(shadow) })),
      false,
    );
  }

  function syncShadowAndAutosave(): void {
    const shadow = currentShadow();
    if (pendingOperation) {
      pendingOperation = updatePendingComposerShadow(
        operationKey,
        pendingOperation,
        shadow,
        environment,
      );
      publish();
      return;
    }
    if (optimisticSends.length > 0) setOptimisticDraftShadow(shadow);
    scheduleAutosave();
    publish();
  }

  function markOptimisticAccepted(operation: OptimisticSendOperation): void {
    if (!optimisticCallbackIds.has(operation.clientEventId)) {
      optimisticCallbackIds.add(operation.clientEventId);
      options.onSent?.(operation.input.text, operation.input);
    }
    replaceOptimisticSends(
      (current) =>
        current.filter((candidate) => candidate.clientEventId !== operation.clientEventId),
      false,
    );
  }

  function reconcileOptimisticEvents(events: readonly SessionEvent[]): void {
    if (events.length === 0 || optimisticSends.length === 0) return;
    const reconciled = optimisticSends.map((operation) =>
      reconcileOptimisticSendFromEvents(operation, events),
    );
    const settledIds = new Set(
      reconciled.filter((item) => item.settled).map((item) => item.operation.clientEventId),
    );
    for (const item of reconciled) {
      if (item.admitted && !optimisticCallbackIds.has(item.operation.clientEventId)) {
        optimisticCallbackIds.add(item.operation.clientEventId);
        options.onSent?.(item.operation.input.text, item.operation.input);
      }
      if (item.settled) markOptimisticAccepted(item.operation);
    }
    replaceOptimisticSends(
      (current) =>
        current
          .map(
            (operation) =>
              reconciled.find((item) => item.operation.clientEventId === operation.clientEventId)
                ?.operation ?? operation,
          )
          .filter((operation) => !settledIds.has(operation.clientEventId)),
      false,
    );
    if (durableDrafts && reconciled.some((item) => item.admitted)) void loadDraft(false);
  }

  function reconcileSteeringFromEvents(events: readonly SessionEvent[]): void {
    if (!steering) return;
    if (steeringSettledByEvents(steering, events)) {
      steering = null;
      publish();
      return;
    }
    const accepted = steeringAcceptedEvent(steering, events);
    if (accepted && !steering.triggerEventId) {
      steering = { ...steering, phase: "accepted", triggerEventId: accepted.id };
      publish();
    }
  }

  async function reconcileBeforeLive(): Promise<void> {
    if (!enabled || store.signal.aborted) return;
    try {
      const events = await store.trackRead(() =>
        options.client.listEvents(options.workspaceId, sessionId, {
          includeTypes: [
            "user.message",
            "turn.queued",
            "turn.started",
            "turn.completed",
            "turn.failed",
            "turn.cancelled",
            "turn.superseded",
          ],
          limit: 250,
          payloadMode: "full",
        }),
      );
      if (store.signal.aborted) return;
      reconcileSteeringFromEvents(events);
      reconcileOptimisticEvents(events);
      publish();
    } catch {
      // The durable stream and explicit retries remain available.
    }
  }

  function processEvent(event: SessionEvent): void {
    if (isComposerDraftRuntimeEvent(event)) void loadDraft(false);
    if (isSteeringSettlementEvent(event)) reconcileSteeringFromEvents([event]);
    if (optimisticSends.length > 0) reconcileOptimisticEvents([event]);
  }

  function processSharedEvents(events: readonly SessionEvent[]): void {
    if (!sharedFeed || !pageLive || store.signal.aborted) return;
    reconcileSteeringFromEvents(events);
    const optimisticBefore = optimisticSends;
    reconcileOptimisticEvents(events);
    if (optimisticSends !== optimisticBefore) publish();
    if (!sharedFeedInitialized) {
      sharedFeedInitialized = true;
      sharedFeedHasEvents = events.length > 0;
      consumedSequence = events.at(-1)?.sequence ?? 0;
      return;
    }
    const firstSequence = events[0]?.sequence ?? 0;
    const firstNonEmptyBatch = !sharedFeedHasEvents && events.length > 0;
    if (firstNonEmptyBatch || firstSequence > consumedSequence + 1) {
      sharedFeedHasEvents = events.length > 0;
      consumedSequence = events.at(-1)?.sequence ?? consumedSequence;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && (isComposerDraftRuntimeEvent(event) || isSteeringSettlementEvent(event))) {
          processEvent(event);
          break;
        }
      }
      return;
    }
    sharedFeedHasEvents ||= events.length > 0;
    for (const event of events) {
      if (event.sequence <= consumedSequence) continue;
      consumedSequence = event.sequence;
      processEvent(event);
    }
  }

  function startStream(): void {
    if (sharedFeed || !pageLive || !enabled || store.signal.aborted || streamAbort) return;
    const owned = ++streamGeneration;
    const controller = new AbortController();
    streamAbort = controller;
    void store.trackStream(async () => {
      try {
        const session = await store.trackRead(() =>
          options.client.getSession(options.workspaceId, sessionId),
        );
        if (owned !== streamGeneration || controller.signal.aborted || store.signal.aborted) return;
        const stream = options.client.streamEvents(options.workspaceId, sessionId, {
          after: session.lastSequence,
          signal: controller.signal,
          onOpen: () => {
            void Promise.resolve()
              .then(reconcileBeforeLive)
              .catch(() => undefined);
          },
        });
        const iterator = stream[Symbol.asyncIterator]();
        streamIterator = iterator;
        for (;;) {
          if (owned !== streamGeneration || controller.signal.aborted || store.signal.aborted) {
            break;
          }
          const next = await iterator.next();
          if (next.done) break;
          processEvent(next.value);
        }
      } catch {
        // Reads and explicit retries remain authoritative.
      } finally {
        if (owned === streamGeneration) {
          streamAbort = null;
          streamIterator = null;
        }
      }
    });
  }

  function stopStream(): void {
    streamGeneration += 1;
    streamAbort?.abort();
    streamAbort = null;
    const iterator = streamIterator;
    streamIterator = null;
    if (iterator?.return) void iterator.return().catch(() => undefined);
  }

  function clearHiddenTimer(): void {
    if (hiddenTimer === undefined) return;
    environment.clock.clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    store.trackTimer(-1);
  }

  function syncVisibility(): void {
    if (!environment.visibility || store.signal.aborted) return;
    if (environment.visibility.getState() === "visible") {
      clearHiddenTimer();
      if (pageLive) return;
      pageLive = true;
      if (durableDrafts) void loadDraft(false);
      processSharedEvents(latestEvents);
      if (!sharedFeed && (durableDrafts || steering !== null)) startStream();
      return;
    }
    if (!pageLive || hiddenTimer !== undefined) return;
    store.trackTimer(1);
    hiddenTimer = environment.clock.setTimeout(() => {
      hiddenTimer = undefined;
      store.trackTimer(-1);
      if (environment.visibility?.getState() !== "hidden") return;
      pageLive = false;
      readGeneration += 1;
      readInFlight?.controller.abort();
      readInFlight = null;
      clearReadRetry();
      stopStream();
      draftLoading = false;
      publish();
    }, options.hiddenGraceMs ?? 2_000);
  }

  function scheduleOptimisticProcessor(): void {
    const schedule =
      environment.scheduleMicrotask ??
      ((callback: () => void) => void Promise.resolve().then(callback));
    schedule(processOptimisticSends);
  }

  function processOptimisticSends(): void {
    if (!enabled || optimisticProcessorBusy || store.signal.aborted) return;
    const operation = optimisticSends.find((candidate) => candidate.state === "sending");
    if (!operation) return;
    const ownedGeneration = generation;
    optimisticProcessorBusy = true;
    void (async () => {
      let mutationFailureObserved = false;
      const markFailed = (problem: Error, outcomeUnknown: boolean): void => {
        if (ownedGeneration !== generation || store.signal.aborted) return;
        replaceOptimisticSends(
          (current) =>
            current.map((candidate) =>
              candidate.clientEventId === operation.clientEventId
                ? { ...candidate, state: "failed", error: problem.message, outcomeUnknown }
                : candidate,
            ),
          false,
        );
      };
      try {
        if (operation.outcomeUnknown) {
          let events: SessionEvent[];
          try {
            events = await store.trackRead(() =>
              options.client.listEvents(options.workspaceId, sessionId, {
                includeTypes: [
                  "user.message",
                  "turn.queued",
                  "turn.started",
                  "turn.completed",
                  "turn.failed",
                  "turn.cancelled",
                  "turn.superseded",
                ],
                limit: 250,
                payloadMode: "full",
              }),
            );
          } catch (cause) {
            markFailed(asError(cause), true);
            return;
          }
          if (ownedGeneration !== generation || store.signal.aborted) return;
          const reconciled = reconcileOptimisticSendFromEvents(operation, events);
          if (reconciled.admitted) {
            if (durableDrafts) await loadDraft(false);
            if (reconciled.settled) {
              markOptimisticAccepted(reconciled.operation);
            } else {
              replaceOptimisticSends(
                (current) =>
                  current.map((candidate) =>
                    candidate.clientEventId === operation.clientEventId
                      ? reconciled.operation
                      : candidate,
                  ),
                false,
              );
              if (!optimisticCallbackIds.has(operation.clientEventId)) {
                optimisticCallbackIds.add(operation.clientEventId);
                options.onSent?.(reconciled.operation.input.text, reconciled.operation.input);
              }
            }
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
          expectedDraftRevision = draft?.revision;
        }
        if (ownedGeneration !== generation || store.signal.aborted) return;
        const wireInput = {
          ...operation.input,
          ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
        };
        let acceptedResult: SubmitComposerDraftResponse | null = null;
        let acceptedEvent: SessionEvent | null = null;
        if (durableDrafts) {
          if (!operation.draftPayload || expectedDraftRevision === undefined) {
            throw new Error("The durable composer draft is not ready for delivery.");
          }
          acceptedResult = await options.client
            .submitComposerDraft(options.workspaceId, sessionId, {
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
            })
            .catch((cause: unknown) => {
              mutationFailureObserved = true;
              throw cause;
            });
          lastSubmitResponse = acceptedResult;
          lastRouting = acceptedResult.routing;
          adoptDraftBase(acceptedResult.draft);
        } else {
          acceptedEvent = await options.client
            .sendMessage(options.workspaceId, sessionId, wireInput)
            .catch((cause: unknown) => {
              mutationFailureObserved = true;
              throw cause;
            });
        }
        if (ownedGeneration !== generation || store.signal.aborted) return;
        const acceptedRouting =
          acceptedResult?.routing ?? promptRoutingFromAcceptedEvent(acceptedEvent);
        const acceptedDestination =
          acceptedRouting === "queued_for_execution"
            ? "queue"
            : acceptedRouting === "accepted_for_execution" ||
                acceptedRouting === "accepted_for_steering"
              ? "chat"
              : operation.destination;
        if (!sharedFeed && acceptedDestination === "chat") {
          markOptimisticAccepted({ ...operation, input: wireInput });
        } else {
          replaceOptimisticSends(
            (current) =>
              current.map((candidate) =>
                candidate.clientEventId === operation.clientEventId
                  ? {
                      ...candidate,
                      input: wireInput,
                      destination: acceptedDestination,
                      turnId: acceptedResult?.turn.id ?? candidate.turnId,
                      triggerEventId:
                        acceptedResult?.accepted.id ??
                        acceptedEvent?.id ??
                        candidate.triggerEventId,
                      appliedQueueVersion:
                        acceptedResult?.receipt?.appliedQueueVersion ??
                        candidate.appliedQueueVersion,
                      state: "queued",
                      error: undefined,
                    }
                  : candidate,
              ),
            false,
          );
        }
        if (!optimisticCallbackIds.has(operation.clientEventId)) {
          optimisticCallbackIds.add(operation.clientEventId);
          options.onSent?.(wireInput.text, wireInput);
        }
      } catch (cause) {
        const current = optimisticSends.find(
          (candidate) => candidate.clientEventId === operation.clientEventId,
        );
        if (!current || (current.state === "queued" && current.outcomeUnknown === false)) return;
        const problem = asError(cause);
        options.onDeliveryError?.(problem, operation.input, "send");
        const outcomeUnknown =
          operation.outcomeUnknown && !mutationFailureObserved
            ? true
            : isOutcomeUnknownError(cause);
        markFailed(problem, outcomeUnknown);
      } finally {
        optimisticProcessorBusy = false;
        if (ownedGeneration === generation && !store.signal.aborted) {
          publish();
          if (optimisticSends.some((candidate) => candidate.state === "sending")) {
            scheduleOptimisticProcessor();
          } else {
            syncShadowAndAutosave();
          }
        }
      }
    })();
  }

  function applyDraft(next: ComposerDraft): void {
    if (store.signal.aborted) return;
    const nextPolicy = policyFromDraft(next);
    localEditRevision += 1;
    value = next.text;
    annotations = cloneAnnotations(next.annotations ?? []);
    policy = nextPolicy;
    restoredResources = [...next.resources];
    if (durableDrafts) {
      draft = next;
      lastSavedSignature = draftSignature(draftPayload(next));
    } else {
      draft = null;
      lastSavedSignature = null;
    }
    pendingOperation = updatePendingComposerShadow(
      operationKey,
      pendingOperation,
      currentShadow(),
      environment,
    );
    setOptimisticDraftShadow(currentShadow());
    draftConflict = null;
    error = null;
    publish();
  }

  async function deliverPending(operation: PendingComposerOperation) {
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
      const result = await options.client.submitComposerDraft(options.workspaceId, sessionId, {
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
        ...(input.mcpCredentialUpdates ? { mcpCredentialUpdates: input.mcpCredentialUpdates } : {}),
        ...(input.connectionAuthorities
          ? { connectionAuthorities: input.connectionAuthorities }
          : {}),
        ...(input.personalResourceAttachment
          ? { personalResourceAttachment: input.personalResourceAttachment }
          : {}),
      });
      lastSubmitResponse = result;
      lastRouting = result.routing;
      adoptDraftBase(result.draft);
      return result;
    }
    if (operation.delivery === "steer") {
      return await options.client.steerMessage(options.workspaceId, sessionId, operation.input);
    }
    await options.client.sendMessage(options.workspaceId, sessionId, operation.input);
    return null;
  }

  async function dispatch(
    delivery: "send" | "steer",
    explicit?: string,
    extrasOverride?: SessionComposerSendExtras,
  ): Promise<boolean> {
    const ownedGeneration = generation;
    const restoredPending =
      pendingOperation ?? restorePendingComposerOperation(operationKey, environment);
    if (restoredPending && !pendingOperation) {
      pendingOperation = restoredPending;
      pendingClientEventId = restoredPending.input.clientEventId ?? null;
    }
    const draftAtSend = value;
    const annotationsAtSend = cloneAnnotations(annotations);
    const rawText = explicit ?? draftAtSend;
    const hasText = rawText.trim().length > 0;
    const hasAnnotations = annotationsAtSend.length > 0;
    const currentPolicy = policy;
    const annotationsComplete = annotationsAtSend.every(
      (annotation) => annotation.note.trim().length > 0,
    );
    const extras = pendingOperation ? {} : currentExtras(extrasOverride);
    const hasResources = restoredResources.length > 0 || (extras.resources?.length ?? 0) > 0;
    if (
      (!pendingOperation &&
        (!annotationsComplete || (!hasText && !hasResources && !hasAnnotations))) ||
      !enabled ||
      !currentPolicy ||
      sending ||
      options.sendBlocked?.() === true ||
      store.signal.aborted
    ) {
      return false;
    }

    const clearPending = (): void => {
      pendingOperation = null;
      pendingClientEventId = null;
      forgetPendingComposerOperation(operationKey, environment);
    };
    const settleAccepted = (operation: PendingComposerOperation): void => {
      clearPending();
      const draftWasUnchanged = value === operation.draftAtSend;
      const resourcesWereUnchanged =
        JSON.stringify(restoredResources) === JSON.stringify(operation.resourcesAtSend);
      const annotationsWereUnchanged =
        JSON.stringify(annotations) === JSON.stringify(operation.annotationsAtSend);
      if (resourcesWereUnchanged) restoredResources = [];
      if (annotationsWereUnchanged) {
        annotations = [];
        annotationReviewTargetId = null;
      }
      if (operation.clearDraftOnAccept && draftWasUnchanged) value = "";
      options.onSent?.(operation.input.text, operation.input);
      syncShadowAndAutosave();
    };

    let keepSteering = pendingOperation?.delivery === "steer";
    if (delivery === "steer") {
      if (steering?.clientEventId !== pendingOperation?.input.clientEventId) {
        steeringOccurredAt = new Date(environment.clock.now()).toISOString();
      }
      steering = {
        phase: "submitting",
        text: rawText,
        clientEventId: pendingOperation?.input.clientEventId ?? pendingClientEventId,
        triggerEventId: null,
        turnId: null,
      };
      if (!sharedFeed) startStream();
    }
    sending = true;
    error = null;
    publish();
    try {
      if (pendingOperation) {
        const operation = pendingOperation;
        let acceptedEvent: SessionEvent | null = null;
        try {
          const events = await store.trackRead(() =>
            options.client.listEvents(options.workspaceId, sessionId, {
              includeTypes: ["user.message"],
              limit: 100,
              payloadMode: "none",
            }),
          );
          acceptedEvent =
            events.find(
              (event) =>
                event.type === "user.message" &&
                event.clientEventId === operation.input.clientEventId,
            ) ?? null;
        } catch (cause) {
          if (ownedGeneration === generation && !store.signal.aborted) {
            error = asError(cause);
            if (operation.delivery === "steer") {
              keepSteering = true;
              steering = {
                phase: "failed",
                text: operation.input.text,
                clientEventId: operation.input.clientEventId ?? null,
                triggerEventId: null,
                turnId: null,
                error: "Not confirmed. Retry.",
                outcomeUnknown: true,
              };
            }
            publish();
          }
          return false;
        }
        if (ownedGeneration !== generation || store.signal.aborted) return false;
        if (acceptedEvent) {
          if (durableDrafts) await loadDraft(false);
          if (operation.delivery === "steer") {
            keepSteering = true;
            steering = {
              phase: "accepted",
              text: operation.input.text,
              clientEventId: operation.input.clientEventId ?? null,
              triggerEventId: acceptedEvent.id,
              turnId: null,
            };
          }
          settleAccepted(operation);
          return true;
        }
        if (!operation.canRetry) {
          error = new Error(
            "OpenGeni cannot safely retry this uncertain request after remount; reconcile the session before sending again.",
          );
          publish();
          return false;
        }
        try {
          const result = await deliverPending(operation);
          if (operation.delivery === "steer" && result) {
            keepSteering = true;
            steering = {
              phase: "accepted",
              text: operation.input.text,
              clientEventId: operation.input.clientEventId ?? null,
              triggerEventId: result.accepted.id,
              turnId: result.turn.id,
              stoppingPreviousAttempt:
                result.replay !== true && (result.interruptionCount ?? 0) > 0,
            };
          }
        } catch (cause) {
          const problem = asError(cause);
          const outcomeUnknown = isOutcomeUnknownError(cause);
          options.onDeliveryError?.(problem, operation.input, operation.delivery);
          if (!outcomeUnknown) {
            clearPending();
            keepSteering = false;
          } else if (operation.delivery === "steer") {
            keepSteering = true;
            steering = {
              phase: "failed",
              text: operation.input.text,
              clientEventId: operation.input.clientEventId ?? null,
              triggerEventId: null,
              turnId: null,
              error: "Not confirmed. Retry.",
              outcomeUnknown: true,
            };
          }
          if (ownedGeneration === generation && !store.signal.aborted) {
            error = problem;
            publish();
          }
          return false;
        }
        if (ownedGeneration !== generation || store.signal.aborted) return false;
        settleAccepted(operation);
        return true;
      }

      const sendText = hasText ? rawText : hasAnnotations ? "" : FILE_ONLY_MESSAGE_TEXT;
      const payload = currentDraftPayload();
      const deliveryPayload = payload ? { ...payload, text: sendText } : null;
      if (deliveryPayload && !(await persistPayload(deliveryPayload))) return false;
      if (ownedGeneration !== generation || store.signal.aborted) return false;
      pendingClientEventId ??= environment.ids.randomUUID();
      const effectiveControl = currentEffectiveControl();
      const input = composeSessionMessageInput(sendText, pendingClientEventId, extras, {
        ...currentPolicy,
        ...(effectiveControl?.controlEtag ? { controlEtag: effectiveControl.controlEtag } : {}),
        ...(durableDrafts && draft ? { expectedDraftRevision: draft.revision } : {}),
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
          policy: { ...currentPolicy },
        },
        clearDraftOnAccept: explicit === undefined,
        canRetry: true,
      };
      pendingOperation = operation;
      rememberPendingComposerOperation(operationKey, operation, environment);
      if (delivery === "steer") {
        steering = {
          phase: "submitting",
          text: sendText,
          clientEventId: input.clientEventId ?? null,
          triggerEventId: null,
          turnId: null,
        };
      }
      try {
        const result = await deliverPending(operation);
        if (delivery === "steer" && result) {
          keepSteering = true;
          steering = {
            phase: "accepted",
            text: sendText,
            clientEventId: input.clientEventId ?? null,
            triggerEventId: result.accepted.id,
            turnId: result.turn.id,
            stoppingPreviousAttempt: result.replay !== true && (result.interruptionCount ?? 0) > 0,
          };
        }
      } catch (cause) {
        options.onDeliveryError?.(asError(cause), operation.input, operation.delivery);
        if (!isOutcomeUnknownError(cause)) {
          clearPending();
        } else if (delivery === "steer") {
          keepSteering = true;
          steering = {
            phase: "failed",
            text: operation.input.text,
            clientEventId: operation.input.clientEventId ?? null,
            triggerEventId: null,
            turnId: null,
            error: "Not confirmed. Retry.",
            outcomeUnknown: true,
          };
        }
        if (ownedGeneration === generation && !store.signal.aborted) {
          error = asError(cause);
          publish();
        }
        return false;
      }
      if (ownedGeneration !== generation || store.signal.aborted) return false;
      settleAccepted(operation);
      return true;
    } finally {
      if (ownedGeneration === generation && !store.signal.aborted) {
        sending = false;
        if (delivery === "steer" && !keepSteering) steering = null;
        publish();
      }
    }
  }

  async function sendOrdinary(
    explicit?: string,
    extrasOverride?: SessionComposerSendExtras,
  ): Promise<boolean> {
    if (pendingOperation?.delivery === "send") {
      return await dispatch("send", explicit, extrasOverride);
    }
    const rawText = explicit ?? value;
    const annotationsAtSend = cloneAnnotations(annotations);
    const currentPolicy = policy;
    const hasText = rawText.trim().length > 0;
    const hasAnnotations = annotationsAtSend.length > 0;
    const annotationsComplete = annotationsAtSend.every(
      (annotation) => annotation.note.trim().length > 0,
    );
    const extras = currentExtras(extrasOverride);
    const resources = mergeResources(restoredResources, extras.resources ?? []);
    if (
      !enabled ||
      !currentPolicy ||
      sending ||
      !annotationsComplete ||
      (!hasText && !hasAnnotations && resources.length === 0) ||
      options.sendBlocked?.() === true ||
      store.signal.aborted
    ) {
      return false;
    }
    const sendText = hasText ? rawText : hasAnnotations ? "" : FILE_ONLY_MESSAGE_TEXT;
    const clientEventId = environment.ids.randomUUID();
    const effectiveControl = currentEffectiveControl();
    const input = composeSessionMessageInput(sendText, clientEventId, extras, {
      ...currentPolicy,
      ...(effectiveControl?.controlEtag ? { controlEtag: effectiveControl.controlEtag } : {}),
      resources,
      annotations: annotationsAtSend,
    });
    const currentPayload = currentDraftPayload();
    const hasEarlierUnsettledSend = optimisticSends.some(
      (candidate) => candidate.state !== "failed" || candidate.outcomeUnknown === true,
    );
    const operation: OptimisticSendOperation = {
      clientEventId,
      delivery: "send",
      destination:
        effectiveControl?.state === "paused" || hasEarlierUnsettledSend
          ? "queue"
          : (options.sendDestination?.() ?? "chat"),
      text: sendText,
      annotations: annotationsAtSend,
      resources,
      occurredAt: new Date(environment.clock.now()).toISOString(),
      state: "sending",
      input,
      draftPayload: currentPayload ? { ...currentPayload, text: sendText } : null,
      newerShadow: {
        text: explicit === undefined ? "" : value,
        resources: explicit === undefined ? [] : [...restoredResources],
        annotations: explicit === undefined ? [] : cloneAnnotations(annotations),
        policy: { ...currentPolicy },
      },
      canRetry: true,
    };
    if (explicit === undefined) {
      value = "";
      annotations = [];
      restoredResources = [];
      annotationReviewTargetId = null;
      localEditRevision += 1;
    }
    replaceOptimisticSends((current) => [...current, operation], false);
    error = null;
    publish();
    scheduleOptimisticProcessor();
    options.onSubmitted?.(sendText, input);
    return true;
  }

  function updateValue(next: string): void {
    if (store.signal.aborted) return;
    localEditRevision += 1;
    value = next;
    syncShadowAndAutosave();
  }

  function updateAnnotations(
    next: readonly DraftTimelineAnnotation[],
    reviewTargetId: string | null = null,
  ): void {
    if (store.signal.aborted) return;
    localEditRevision += 1;
    annotations = cloneAnnotations(next);
    annotationReviewTargetId = reviewTargetId;
    syncShadowAndAutosave();
  }

  function updatePolicy(next: SessionComposerPolicy): void {
    if (store.signal.aborted) return;
    localEditRevision += 1;
    policy = { ...next };
    syncShadowAndAutosave();
  }

  function updateResources(next: readonly ResourceRef[]): void {
    if (store.signal.aborted) return;
    localEditRevision += 1;
    restoredResources = [...next];
    syncShadowAndAutosave();
  }

  async function pause(reason?: string): Promise<void> {
    const ownedGeneration = generation;
    if (!enabled || pausing || store.signal.aborted) return;
    pausing = true;
    error = null;
    publish();
    try {
      const clientEventId = environment.ids.randomUUID();
      const effectiveControl = currentEffectiveControl();
      const result = await replayOutcomeUnknown(() =>
        options.client.pauseSession(options.workspaceId, sessionId, {
          clientEventId,
          ...(reason === undefined ? {} : { reason }),
          ...(effectiveControl?.controlEtag
            ? { expectedControlEtag: effectiveControl.controlEtag }
            : {}),
        }),
      );
      if (ownedGeneration === generation && !store.signal.aborted) {
        acceptedControl = result.effectiveControl;
      }
    } catch (cause) {
      if (ownedGeneration === generation && !store.signal.aborted) error = asError(cause);
    } finally {
      if (ownedGeneration === generation && !store.signal.aborted) {
        pausing = false;
        publish();
      }
    }
  }

  async function resume(reason?: string): Promise<void> {
    const ownedGeneration = generation;
    if (!enabled || resuming || store.signal.aborted) return;
    resuming = true;
    error = null;
    publish();
    try {
      const clientEventId = environment.ids.randomUUID();
      const effectiveControl = currentEffectiveControl();
      const result = await replayOutcomeUnknown(() =>
        options.client.resumeSession(options.workspaceId, sessionId, {
          clientEventId,
          ...(reason === undefined ? {} : { reason }),
          ...(effectiveControl?.controlEtag
            ? { expectedControlEtag: effectiveControl.controlEtag }
            : {}),
        }),
      );
      if (ownedGeneration === generation && !store.signal.aborted) {
        acceptedControl = result.effectiveControl;
      }
    } catch (cause) {
      if (ownedGeneration === generation && !store.signal.aborted) error = asError(cause);
    } finally {
      if (ownedGeneration === generation && !store.signal.aborted) {
        resuming = false;
        publish();
      }
    }
  }

  async function resumeScope(option: EffectiveControlResumeOption): Promise<void> {
    const ownedGeneration = generation;
    if (!enabled || resuming || store.signal.aborted) return;
    resuming = true;
    error = null;
    publish();
    try {
      if (option.scope === "workspace") {
        const blocker = currentEffectiveControl()?.blockers.find(
          (candidate) => candidate.kind === "workspace",
        );
        if (!options.client.setWorkspaceInferenceState) {
          throw new Error("Workspace-scoped resume requires setWorkspaceInferenceState.");
        }
        const clientEventId = environment.ids.randomUUID();
        await replayOutcomeUnknown(() =>
          options.client.setWorkspaceInferenceState!(options.workspaceId, {
            action: "resume",
            clientEventId,
            ...(blocker ? { expectedRevision: blocker.revision } : {}),
          }),
        );
      } else if (option.scope === "session" && option.targetId) {
        const target = await options.client.getQueue(options.workspaceId, option.targetId);
        if (ownedGeneration !== generation || store.signal.aborted) return;
        const clientEventId = environment.ids.randomUUID();
        await replayOutcomeUnknown(() =>
          options.client.resumeSession(options.workspaceId, option.targetId!, {
            clientEventId,
            expectedControlEtag: target.effectiveControl.controlEtag,
          }),
        );
      } else {
        const clientEventId = environment.ids.randomUUID();
        const effectiveControl = currentEffectiveControl();
        const result = await replayOutcomeUnknown(() =>
          options.client.resumeSession(options.workspaceId, sessionId, {
            clientEventId,
            ...(effectiveControl?.controlEtag
              ? { expectedControlEtag: effectiveControl.controlEtag }
              : {}),
          }),
        );
        if (ownedGeneration === generation && !store.signal.aborted) {
          acceptedControl = result.effectiveControl;
        }
      }
    } catch (cause) {
      if (ownedGeneration === generation && !store.signal.aborted) error = asError(cause);
    } finally {
      if (ownedGeneration === generation && !store.signal.aborted) {
        resuming = false;
        publish();
      }
    }
  }

  async function resolveDraftConflict(choice: "keep_mine" | "use_remote"): Promise<void> {
    const ownedGeneration = generation;
    if (!enabled || !durableDrafts || store.signal.aborted) return;
    const remote = await store.trackRead(() =>
      options.client.getComposerDraft(options.workspaceId, sessionId),
    );
    if (ownedGeneration !== generation || store.signal.aborted) return;
    if (choice === "use_remote") {
      applyDraft(remote);
      return;
    }
    draft = remote;
    draftConflict = null;
    error = null;
    const payload = currentDraftPayload();
    publish();
    if (payload) await persistPayload({ ...payload, expectedRevision: remote.revision });
  }

  function retryOptimisticMessage(clientEventId: string): void {
    if (options.sendBlocked?.() === true || store.signal.aborted) return;
    if (steering?.phase === "failed" && steering.clientEventId === clientEventId) {
      void dispatch("steer");
      return;
    }
    replaceOptimisticSends(
      (current) =>
        current.map((operation) => {
          if (operation.clientEventId !== clientEventId || operation.state !== "failed") {
            return operation;
          }
          if (operation.outcomeUnknown) {
            return { ...operation, state: "sending", error: undefined };
          }
          const nextClientEventId = environment.ids.randomUUID();
          const personalResourceAttachment = currentExtras().personalResourceAttachment;
          const retryInput = composeSessionMessageInput(
            operation.text,
            nextClientEventId,
            {
              ...operation.input,
              ...(personalResourceAttachment ? { personalResourceAttachment } : {}),
            },
            {
              ...(currentEffectiveControl()?.controlEtag
                ? { controlEtag: currentEffectiveControl()!.controlEtag }
                : {}),
              resources: operation.resources,
              annotations: operation.annotations,
            },
          );
          return {
            ...operation,
            clientEventId: nextClientEventId,
            input: retryInput,
            occurredAt: new Date(environment.clock.now()).toISOString(),
            state: "sending",
            error: undefined,
            outcomeUnknown: false,
            canRetry: true,
          };
        }),
      false,
    );
    publish();
    scheduleOptimisticProcessor();
  }

  function removeOptimisticMessage(clientEventId: string): void {
    if (steering?.clientEventId === clientEventId) {
      pendingOperation = null;
      pendingClientEventId = null;
      forgetPendingComposerOperation(operationKey, environment);
      steering = null;
      error = null;
      publish();
      return;
    }
    replaceOptimisticSends((current) =>
      current.filter((operation) => operation.clientEventId !== clientEventId),
    );
  }

  function hasDraftContent(): boolean {
    const extras = currentExtras();
    return (
      value.length > 0 ||
      annotations.length > 0 ||
      restoredResources.length > 0 ||
      (extras.resources?.length ?? 0) > 0 ||
      (draft?.sourceTurnId !== null && draft?.sourceTurnId !== undefined)
    );
  }

  const runtime = Object.assign(store, {
    applyEvents(events: readonly SessionEvent[]) {
      latestEvents = events;
      if (store.diagnostics().started && pageLive) processSharedEvents(events);
    },
    syncExternalInputs() {
      const nextVersion = JSON.stringify(currentExtras());
      const nextSendBlocked = options.sendBlocked?.() === true;
      if (nextVersion !== lastExtrasVersion) {
        lastExtrasVersion = nextVersion;
        lastSendBlocked = nextSendBlocked;
        syncShadowAndAutosave();
      } else if (nextSendBlocked !== lastSendBlocked) {
        lastSendBlocked = nextSendBlocked;
        publish();
      }
    },
    setEffectiveControl(control: EffectiveSessionControl | null | undefined) {
      const nextControl = control ?? null;
      const nextVersion = JSON.stringify(nextControl);
      const suppliedChanged = nextVersion !== suppliedEffectiveControlVersion;
      suppliedEffectiveControl = nextControl;
      suppliedEffectiveControlVersion = nextVersion;
      let acceptedChanged = false;
      if (
        acceptedControl &&
        suppliedEffectiveControl &&
        suppliedEffectiveControl.controlVersion >= acceptedControl.controlVersion
      ) {
        acceptedControl = null;
        acceptedChanged = true;
      }
      if (suppliedChanged || acceptedChanged) publish();
    },
    setValue: updateValue,
    setText: updateValue,
    setAnnotations: (next: readonly DraftTimelineAnnotation[]) => updateAnnotations(next),
    addAnnotation(annotation: DraftTimelineAnnotation) {
      if (annotations.length >= 12) {
        error = new Error("A message can include at most 12 timeline annotations.");
        publish();
        return;
      }
      updateAnnotations([...annotations, annotation], annotation.id);
    },
    updateAnnotation(id: string, note: string) {
      updateAnnotations(
        annotations.map((annotation) =>
          annotation.id === id ? { ...annotation, note } : annotation,
        ),
      );
    },
    removeAnnotation(id: string) {
      updateAnnotations(annotations.filter((annotation) => annotation.id !== id));
    },
    clearAnnotationReviewTarget() {
      annotationReviewTargetId = null;
      publish();
    },
    setResources: updateResources,
    removeRestoredResource(index: number) {
      updateResources(restoredResources.filter((_, candidate) => candidate !== index));
    },
    setModel(model: string) {
      if (policy) updatePolicy({ ...policy, model });
    },
    setReasoningEffort(reasoningEffort: ReasoningEffort) {
      if (policy) updatePolicy({ ...policy, reasoningEffort });
    },
    setLatencyMode(latencyMode: LatencyMode) {
      if (policy) updatePolicy({ ...policy, latencyMode });
    },
    hasDraftContent,
    send: sendOrdinary,
    steer: async (text?: string) => await dispatch("steer", text),
    async submit(
      delivery: "send" | "steer" = "send",
      extras: SessionComposerSendExtras = {},
    ): Promise<SubmitComposerDraftResponse | null> {
      lastSubmitResponse = null;
      if (delivery === "steer") await dispatch("steer", undefined, extras);
      else await sendOrdinary(undefined, extras);
      return lastSubmitResponse;
    },
    retryOptimisticMessage,
    removeOptimisticMessage,
    pause,
    resume,
    resumeScope,
    applyDraft,
    replaceDraft: applyDraft,
    refresh: async () => await loadDraft(false),
    reloadDraft: async () => await loadDraft(true),
    async saveNow(): Promise<ComposerDraft | null> {
      clearAutosave();
      const payload = currentDraftPayload();
      if (!payload) return draft;
      return (await persistPayload(payload)) ? draft : null;
    },
    resolveDraftConflict,
    clearError() {
      error = null;
      draftConflict = null;
      publish();
    },
    clearMutationError() {
      error = null;
      publish();
    },
    diagnostics: store.diagnostics,
  }) satisfies SessionComposerRuntimeStore;

  publish();
  return runtime;
}

/** Events that can atomically replace or clear this subject's durable draft. */
export function isComposerDraftRuntimeEvent(event: Pick<SessionEvent, "type">): boolean {
  return isComposerDraftEvent(event);
}
