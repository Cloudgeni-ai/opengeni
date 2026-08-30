import type {
  ComposerDraft,
  DraftTimelineAnnotation,
  EffectiveControlResumeOption,
  EffectiveSessionControl,
  LatencyMode,
  ReasoningEffort,
  ResourceRef,
  SendMessageInput,
  SessionEvent,
} from "@opengeni/sdk";
import {
  composeSessionMessageInput,
  createSessionComposerRuntimeStore,
  FILE_ONLY_MESSAGE_TEXT as SDK_FILE_ONLY_MESSAGE_TEXT,
  isComposerDraftEvent as isSdkComposerDraftEvent,
  resolveSessionComposerSendExtras,
  shouldSteerSessionComposerOnKey,
  shouldSubmitSessionComposerOnKey,
  type SessionComposerRuntimeOptions,
  type SessionComposerRuntimeStore,
  type SessionComposerSendExtras,
} from "@opengeni/sdk/session";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

export type ComposerPolicy = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

export type ComposerSendExtras = SessionComposerSendExtras;

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
    /** Immediate user-visible destination for an ordinary Send before admission replies. */
    sendDestination?: (() => "chat" | "queue") | undefined;
    /** Disable remote composer-draft reads and writes for embedded hosts. */
    draftPersistence?: "durable" | "disabled" | undefined;
    /** Required explicit authority when durable draft persistence is disabled. */
    initialPolicy?: ComposerPolicy | undefined;
  };

export type ComposerOptimisticMessage = {
  clientEventId: string;
  delivery: "send" | "steer";
  destination: "chat" | "queue";
  text: string;
  annotations: DraftTimelineAnnotation[];
  resources: ResourceRef[];
  occurredAt: string;
  state: "sending" | "queued" | "failed";
  turnId?: string | null | undefined;
  triggerEventId?: string | null | undefined;
  appliedQueueVersion?: number | null | undefined;
  error?: string | undefined;
  outcomeUnknown?: boolean | undefined;
};

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
  /** Mutation-confirmed control while the streamed queue projection catches up. */
  effectiveControl?: EffectiveSessionControl | null | undefined;
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
  phase: "submitting" | "accepted" | "failed";
  text: string;
  clientEventId: string | null;
  triggerEventId: string | null;
  turnId: string | null;
  /** True only when the accepted Steer durably interrupted a live attempt. */
  stoppingPreviousAttempt?: boolean | undefined;
  error?: string | undefined;
  outcomeUnknown?: boolean | undefined;
};

type OwnedComposerRuntime = {
  options: SessionComposerRuntimeOptions;
  store: SessionComposerRuntimeStore;
};

/** React compatibility adapter over the framework-neutral composer controller. */
export function useComposer(
  sessionId: string | null | undefined,
  options: UseComposerOptions = {},
): ComposerControllerState {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedSession(options);
  const durableDrafts = options.draftPersistence !== "disabled";
  if (!durableDrafts && !options.initialPolicy) {
    throw new Error("useComposer requires initialPolicy when draft persistence is disabled");
  }
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${durableDrafts ? "durable" : "disabled"}\u0000${enabled ? "enabled" : "disabled"}\u0000${sharedFeed ? "shared" : "owned"}`;

  const owned = useMemo<OwnedComposerRuntime>(() => {
    const runtimeOptions: SessionComposerRuntimeOptions = {
      client,
      workspaceId,
      sessionId,
      enabled,
      draftPersistence: durableDrafts ? "durable" : "disabled",
      ...(options.initialPolicy ? { initialPolicy: options.initialPolicy } : {}),
      ...(sharedFeed ? { events: options.events ?? [] } : {}),
      ...(options.sendExtras === undefined ? {} : { sendExtras: options.sendExtras }),
      ...(options.sendBlocked === undefined ? {} : { sendBlocked: options.sendBlocked }),
      ...(options.effectiveControl === undefined
        ? {}
        : { effectiveControl: options.effectiveControl }),
      ...(options.sendDestination === undefined
        ? {}
        : { sendDestination: options.sendDestination }),
      ...(options.onSubmitted === undefined ? {} : { onSubmitted: options.onSubmitted }),
      ...(options.onSent === undefined ? {} : { onSent: options.onSent }),
      ...(options.onDeliveryError === undefined
        ? {}
        : { onDeliveryError: options.onDeliveryError }),
    };
    return {
      options: runtimeOptions,
      store: createSessionComposerRuntimeStore(runtimeOptions),
    };
    // The client and host callbacks are committed into this target-local cell
    // below. Excluding them here prevents harmless identity churn from
    // replacing a session controller or restarting its bounded read retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  const snapshot = useSyncExternalStore(
    owned.store.subscribe,
    owned.store.getSnapshot,
    owned.store.getSnapshot,
  );

  useLayoutEffect(() => {
    owned.options.client = client;
    owned.options.sendExtras = options.sendExtras;
    owned.options.sendBlocked = options.sendBlocked;
    owned.options.sendDestination = options.sendDestination;
    owned.options.onSubmitted = options.onSubmitted;
    owned.options.onSent = options.onSent;
    owned.options.onDeliveryError = options.onDeliveryError;
    owned.store.syncExternalInputs();
  }, [
    client,
    options.onDeliveryError,
    options.onSent,
    options.onSubmitted,
    options.sendBlocked,
    options.sendDestination,
    options.sendExtras,
    owned,
  ]);
  useLayoutEffect(() => {
    if (sharedFeed) owned.store.applyEvents(options.events ?? []);
  }, [options.events, owned.store, sharedFeed]);
  useLayoutEffect(() => {
    owned.store.setEffectiveControl(options.effectiveControl);
  }, [options.effectiveControl, owned.store]);
  useOwnedExternalStore(owned.store);

  useEffect(() => {
    if (!enabled || !durableDrafts || !sessionId) return;
    return registerSessionReconciler(sessionId, "composer", owned.store.refresh);
  }, [durableDrafts, enabled, owned.store, registerSessionReconciler, sessionId]);

  return {
    value: snapshot.value,
    setValue: owned.store.setValue,
    annotations: snapshot.annotations as DraftTimelineAnnotation[],
    addAnnotation: owned.store.addAnnotation,
    updateAnnotation: owned.store.updateAnnotation,
    removeAnnotation: owned.store.removeAnnotation,
    annotationReviewTargetId: snapshot.annotationReviewTargetId,
    clearAnnotationReviewTarget: owned.store.clearAnnotationReviewTarget,
    hasDraftContent: owned.store.hasDraftContent,
    send: owned.store.send,
    optimisticMessages: snapshot.optimisticMessages.map((message) => ({
      ...message,
      annotations: [...message.annotations],
      resources: [...message.resources],
    })),
    retryOptimisticMessage: owned.store.retryOptimisticMessage,
    removeOptimisticMessage: owned.store.removeOptimisticMessage,
    steer: owned.store.steer,
    steering: snapshot.steering as ComposerSteeringState | null,
    stoppingAttempt: snapshot.stoppingAttempt,
    sending: snapshot.sending,
    canSend: snapshot.canSend,
    pause: owned.store.pause,
    pausing: snapshot.pausing,
    resume: owned.store.resume,
    resumeScope: owned.store.resumeScope,
    resuming: snapshot.resuming,
    effectiveControl: snapshot.effectiveControl,
    draft: snapshot.draft,
    draftRevision: snapshot.draftRevision,
    draftLoading: snapshot.draftLoading,
    draftSaving: snapshot.draftSaving,
    draftConflict: snapshot.draftConflict,
    policy: snapshot.policy as ComposerPolicy | null,
    setModel: owned.store.setModel,
    setReasoningEffort: owned.store.setReasoningEffort,
    setLatencyMode: owned.store.setLatencyMode,
    draftPersistence: snapshot.draftPersistence,
    applyDraft: owned.store.applyDraft,
    reloadDraft: owned.store.reloadDraft,
    resolveDraftConflict: owned.store.resolveDraftConflict,
    restoredResources: snapshot.restoredResources as ResourceRef[],
    removeRestoredResource: owned.store.removeRestoredResource,
    error: snapshot.error,
    clearError: owned.store.clearError,
  };
}

/** Events that can atomically replace or clear this subject's durable draft. */
export function isComposerDraftEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkComposerDraftEvent(event);
}

/**
 * Default text for a resource-only message (attachments present, no typed
 * draft). Kept non-empty so the wire contract and worker guard accept it.
 */
export const FILE_ONLY_MESSAGE_TEXT = SDK_FILE_ONLY_MESSAGE_TEXT;

/** Resolve possibly-deferred extras to a concrete bag (function evaluated now). */
export function resolveSendExtras(
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
): ComposerSendExtras {
  return resolveSessionComposerSendExtras(extras);
}

/** Merge the draft text + idempotency key with caller extras. Exported for compatibility. */
export function composeSendInput(
  text: string,
  clientEventId: string,
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
  bound: Partial<SendMessageInput> = {},
): SendMessageInput {
  return composeSessionMessageInput(text, clientEventId, extras, bound);
}

/** Submit on plain Enter; Shift+Enter inserts a newline. */
export function shouldSubmitOnKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return shouldSubmitSessionComposerOnKey(event);
}

/** Cmd/Ctrl+Enter steers; ordinary Enter appends to the queue. */
export function shouldSteerOnKey(event: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return shouldSteerSessionComposerOnKey(event);
}
