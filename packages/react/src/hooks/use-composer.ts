import type {
  ComposerDraft,
  EffectiveControlResumeOption,
  EffectiveSessionControl,
  ResourceRef,
  SaveComposerDraftRequest,
  SendMessageInput,
  SessionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useSessionEventTrigger, type SessionEventFeedOptions } from "./internal";

export type ComposerSendExtras = Omit<SendMessageInput, "text" | "clientEventId">;

export type UseComposerOptions = ClientOverride &
  SessionEventFeedOptions & {
    /** Called with the accepted text after a successful send. */
    onSent?: ((text: string) => void) | undefined;
    /**
     * Extra message fields (resources, tools, model, reasoningEffort) merged
     * into every send. A function is evaluated at send time so it can read the
     * surrounding UI state (attachment pickers, model selectors, ...).
     */
    sendExtras?: ComposerSendExtras | (() => ComposerSendExtras) | undefined;
    /** Latest server-derived workstream control; bound into Send/Steer OCC. */
    effectiveControl?: EffectiveSessionControl | null | undefined;
    /** Apply durable model/tool/reasoning settings in the host's controlled UI. */
    onDraftApplied?: ((draft: ComposerDraft) => void) | undefined;
  };

export type ComposerState = {
  value: string;
  setValue: (value: string) => void;
  /** Read the current draft synchronously before a destructive replacement. */
  hasDraftContent: () => boolean;
  /** Append the draft behind prompts already visible in the queue. */
  send: (text?: string) => Promise<boolean>;
  /** Supersede current direction with the draft. */
  steer: (text?: string) => Promise<boolean>;
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
  /** Apply an atomic queue Edit checkout without a second read. */
  applyDraft: (draft: ComposerDraft) => void;
  reloadDraft: () => Promise<void>;
  resolveDraftConflict: (choice: "keep_mine" | "use_remote") => Promise<void>;
  restoredResources: ResourceRef[];
  removeRestoredResource: (index: number) => void;
  error: Error | null;
  clearError: () => void;
};

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
  const { client, workspaceId, registerSessionReconciler } = useOpenGeni(options);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(Boolean(sessionId));
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftConflict, setDraftConflict] = useState<Error | null>(null);
  const [restoredResources, setRestoredResources] = useState<ResourceRef[]>([]);
  const pendingClientEventId = useRef<string | null>(null);
  const valueRef = useRef("");
  const draftRef = useRef<ComposerDraft | null>(null);
  const restoredResourcesRef = useRef<ResourceRef[]>([]);
  const localEditRevision = useRef(0);
  const targetGeneration = useRef(0);
  const lastSavedSignature = useRef<string | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const onSent = options.onSent;
  const onDraftApplied = options.onDraftApplied;
  // Read through a ref so a new extras closure (created every render by
  // callers passing inline functions) does not invalidate `send`.
  const sendExtrasRef = useRef(options.sendExtras);
  sendExtrasRef.current = options.sendExtras;
  const liveExtrasVersion = JSON.stringify(resolveSendExtras(options.sendExtras));

  // A composer is bound to one session: switching targets must not leak the
  // previous session's draft, error, or retry idempotency key.
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      targetGeneration.current += 1;
      pendingClientEventId.current = null;
      localEditRevision.current = 0;
      valueRef.current = "";
      draftRef.current = null;
      restoredResourcesRef.current = [];
      lastSavedSignature.current = null;
      setValue("");
      setError(null);
      setDraft(null);
      setDraftConflict(null);
      setRestoredResources([]);
    }
  }, [targetKey]);

  const applyDraft = useCallback(
    (next: ComposerDraft): void => {
      valueRef.current = next.text;
      draftRef.current = next;
      restoredResourcesRef.current = next.resources;
      lastSavedSignature.current = draftSignature(draftPayload(next));
      localEditRevision.current += 1;
      pendingClientEventId.current = null;
      setDraft(next);
      setValue(next.text);
      setRestoredResources(next.resources);
      setDraftConflict(null);
      onDraftApplied?.(next);
    },
    [onDraftApplied],
  );

  const loadDraft = useCallback(
    async (replaceLocal: boolean): Promise<void> => {
      if (!sessionId) return;
      const generation = targetGeneration.current;
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
      setDraftLoading(true);
      try {
        const fetched = await client.getComposerDraft(workspaceId, sessionId);
        if (generation !== targetGeneration.current) return;
        draftRef.current = fetched;
        setDraft(fetched);
        setDraftConflict(null);
        if (replaceLocal || (!localWasDirtyAtStart && localAtStart === localEditRevision.current)) {
          valueRef.current = fetched.text;
          restoredResourcesRef.current = fetched.resources;
          lastSavedSignature.current = draftSignature(draftPayload(fetched));
          setValue(fetched.text);
          setRestoredResources(fetched.resources);
          onDraftApplied?.(fetched);
        }
      } catch (cause) {
        if (generation === targetGeneration.current) setError(asError(cause));
      } finally {
        if (generation === targetGeneration.current) setDraftLoading(false);
      }
    },
    [client, onDraftApplied, sessionId, workspaceId],
  );

  useEffect(() => {
    if (!sessionId) {
      setDraftLoading(false);
      return;
    }
    void loadDraft(false);
  }, [loadDraft, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    return registerSessionReconciler(sessionId, "composer", async () => await loadDraft(false));
  }, [loadDraft, registerSessionReconciler, sessionId]);
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isComposerDraftEvent,
    () => void loadDraft(false),
    {
      enabled: Boolean(sessionId),
      ...(options.events !== undefined ? { events: options.events } : {}),
    },
  );

  const currentDraftPayload = useCallback((): SaveComposerDraftRequest | null => {
    const base = draftRef.current;
    if (!base) return null;
    const extras = resolveSendExtras(sendExtrasRef.current);
    return composerDraftPayload(base, value, restoredResources, extras);
  }, [restoredResources, value]);

  const persistPayload = useCallback(
    async (payload: SaveComposerDraftRequest): Promise<boolean> => {
      if (!sessionId) return false;
      let success = false;
      const run = async () => {
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
          draftRef.current = saved;
          setDraft(saved);
          lastSavedSignature.current = signature;
          setDraftConflict(null);
          success = true;
        } catch (cause) {
          const problem = asError(cause);
          setDraftConflict(problem);
          setError(problem);
        } finally {
          setDraftSaving(false);
        }
      };
      saveChain.current = saveChain.current.then(run, run);
      await saveChain.current;
      return success;
    },
    [client, sessionId, workspaceId],
  );

  // Private durable autosave. A newer local edit is never replaced by an older
  // response; saves serialize and each reads the latest acknowledged revision.
  useEffect(() => {
    if (!sessionId || draftLoading || sending || !draftRef.current || draftConflict) return;
    const payload = currentDraftPayload();
    if (!payload || draftSignature(payload) === lastSavedSignature.current) return;
    const timer = window.setTimeout(() => void persistPayload(payload), 500);
    return () => window.clearTimeout(timer);
  }, [
    currentDraftPayload,
    draftConflict,
    draftLoading,
    liveExtrasVersion,
    persistPayload,
    sending,
    sessionId,
  ]);

  const dispatch = useCallback(
    async (delivery: "send" | "steer", explicit?: string): Promise<boolean> => {
      const draftAtSend = value;
      const text = (explicit ?? draftAtSend).trim();
      // Resolve the extras once: a file-only message (empty text + ≥1 ready
      // resource) is legitimate, so we must not bail on empty text alone.
      const extras = resolveSendExtras(sendExtrasRef.current);
      const hasResources = restoredResources.length > 0 || (extras.resources?.length ?? 0) > 0;
      if ((!text && !hasResources) || !sessionId || sending) {
        return false;
      }
      // Reuse the clientEventId across retries of the same draft so a
      // timeout + resend cannot double-deliver the message.
      pendingClientEventId.current ??= generateClientEventId();
      setSending(true);
      setError(null);
      try {
        const payload = currentDraftPayload();
        if (payload && !(await persistPayload(payload))) return false;
        // The wire contract requires non-empty text (z.string().min(1)) and the
        // worker rejects whitespace-only text; a file-only message therefore
        // carries a minimal default so the attachments still get delivered.
        const sendText = text || FILE_ONLY_MESSAGE_TEXT;
        const acknowledgedDraft = draftRef.current;
        const sendExtras =
          acknowledgedDraft?.toolsProvided === true &&
          !Object.prototype.hasOwnProperty.call(extras, "tools")
            ? { ...extras, tools: acknowledgedDraft.tools }
            : extras;
        const input = composeSendInput(sendText, pendingClientEventId.current, sendExtras, {
          ...(options.effectiveControl?.controlEtag
            ? { controlEtag: options.effectiveControl.controlEtag }
            : {}),
          ...(draftRef.current ? { expectedDraftRevision: draftRef.current.revision } : {}),
          resources: mergeResources(restoredResources, extras.resources ?? []),
        });
        if (delivery === "steer") {
          await client.steerMessage(workspaceId, sessionId, input);
        } else {
          await client.sendMessage(workspaceId, sessionId, input);
        }
        pendingClientEventId.current = null;
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
          restoredResourcesRef.current = [];
          setDraft(cleared);
          setRestoredResources([]);
          lastSavedSignature.current = draftSignature(draftPayload(cleared));
        }
        if (explicit === undefined) {
          // Clear only the draft that was sent: edits made while the request
          // was in flight were never delivered and must survive.
          if (valueRef.current === draftAtSend) {
            valueRef.current = "";
            setValue("");
          }
        }
        onSent?.(sendText);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        return false;
      } finally {
        setSending(false);
      }
    },
    [
      client,
      currentDraftPayload,
      onSent,
      options.effectiveControl?.controlEtag,
      persistPayload,
      restoredResources,
      sending,
      sessionId,
      value,
      workspaceId,
    ],
  );

  const send = useCallback(async (text?: string) => await dispatch("send", text), [dispatch]);
  const steer = useCallback(async (text?: string) => await dispatch("steer", text), [dispatch]);

  // A send is possible with non-empty text OR with ≥1 attached resource (a
  // file-only message). Resources ride in `sendExtras`, so we resolve them here
  // — keeping useComposer attachment-agnostic while still lighting up the send
  // affordance the moment a file is ready. ChatComposer additionally gates this
  // on its `attachments.uploading` flag so a message never departs mid-upload.
  const hasReadyResources =
    restoredResources.length > 0 ||
    (resolveSendExtras(sendExtrasRef.current).resources?.length ?? 0) > 0;

  const pause = useCallback(
    async (reason?: string): Promise<void> => {
      if (!sessionId || pausing) {
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
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setPausing(false);
      }
    },
    [client, workspaceId, sessionId, pausing, options.effectiveControl?.controlEtag],
  );

  const resume = useCallback(
    async (reason?: string): Promise<void> => {
      if (!sessionId || resuming) return;
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
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setResuming(false);
      }
    },
    [client, workspaceId, sessionId, resuming, options.effectiveControl?.controlEtag],
  );

  const resumeScope = useCallback(
    async (option: EffectiveControlResumeOption): Promise<void> => {
      if (!sessionId || resuming) return;
      setResuming(true);
      setError(null);
      try {
        if (option.scope === "workspace") {
          const workspaceBlocker = options.effectiveControl?.blockers.find(
            (blocker) => blocker.kind === "workspace",
          );
          await client.setWorkspaceInferenceState(workspaceId, {
            action: "resume",
            clientEventId: generateClientEventId(),
            ...(workspaceBlocker ? { expectedRevision: workspaceBlocker.revision } : {}),
          });
        } else if (option.scope === "session" && option.targetId) {
          const target = await client.getQueue(workspaceId, option.targetId);
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
        setError(asError(cause));
      } finally {
        setResuming(false);
      }
    },
    [client, options.effectiveControl, resuming, sessionId, workspaceId],
  );

  const updateValue = useCallback((next: string) => {
    pendingClientEventId.current = null;
    localEditRevision.current += 1;
    valueRef.current = next;
    setValue(next);
  }, []);

  const removeRestoredResource = useCallback((index: number) => {
    localEditRevision.current += 1;
    const next = restoredResourcesRef.current.filter((_, candidate) => candidate !== index);
    restoredResourcesRef.current = next;
    setRestoredResources(next);
  }, []);

  const hasDraftContent = useCallback((): boolean => {
    const current = draftRef.current;
    const extras = resolveSendExtras(sendExtrasRef.current);
    const toolsProvidedByHost = Object.prototype.hasOwnProperty.call(extras, "tools");
    const tools = toolsProvidedByHost ? (extras.tools ?? []) : (current?.tools ?? []);
    return (
      valueRef.current.length > 0 ||
      restoredResourcesRef.current.length > 0 ||
      (extras.resources?.length ?? 0) > 0 ||
      tools.length > 0 ||
      (current?.sourceTurnId !== null && current?.sourceTurnId !== undefined)
    );
  }, []);

  const resolveDraftConflict = useCallback(
    async (choice: "keep_mine" | "use_remote"): Promise<void> => {
      if (!sessionId) return;
      const remote = await client.getComposerDraft(workspaceId, sessionId);
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
    [applyDraft, client, currentDraftPayload, persistPayload, sessionId, workspaceId],
  );

  return {
    value,
    setValue: updateValue,
    hasDraftContent,
    send,
    steer,
    sending,
    canSend: Boolean(sessionId) && !sending && (value.trim().length > 0 || hasReadyResources),
    pause,
    pausing,
    resume,
    resumeScope,
    resuming,
    draft,
    draftRevision: draft?.revision ?? 0,
    draftLoading,
    draftSaving,
    draftConflict,
    applyDraft,
    reloadDraft: useCallback(async () => await loadDraft(true), [loadDraft]),
    resolveDraftConflict,
    restoredResources,
    removeRestoredResource,
    error,
    clearError: useCallback(() => {
      setError(null);
      setDraftConflict(null);
    }, []),
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

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function draftPayload(draft: ComposerDraft): SaveComposerDraftRequest {
  return {
    expectedRevision: draft.revision,
    text: draft.text,
    resources: draft.resources,
    tools: draft.tools,
    toolsProvided: draft.toolsProvided,
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
  };
}

function composerDraftPayload(
  base: ComposerDraft,
  text: string,
  restoredResources: ResourceRef[],
  extras: ComposerSendExtras,
): SaveComposerDraftRequest {
  const toolsProvidedByHost = Object.prototype.hasOwnProperty.call(extras, "tools");
  return {
    expectedRevision: base.revision,
    text,
    resources: mergeResources(restoredResources, extras.resources ?? []),
    tools: toolsProvidedByHost ? (extras.tools ?? []) : base.tools,
    toolsProvided: toolsProvidedByHost ? true : base.toolsProvided,
    model: extras.model ?? base.model,
    reasoningEffort: extras.reasoningEffort ?? base.reasoningEffort,
  };
}

function draftSignature(payload: SaveComposerDraftRequest): string {
  const { expectedRevision: _revision, ...content } = payload;
  return JSON.stringify(content);
}

function mergeResources(base: ResourceRef[], additions: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return [...base, ...additions].filter((resource) => {
    const key = JSON.stringify(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
