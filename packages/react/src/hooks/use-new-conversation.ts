import {
  OpenGeniApiError,
  type FileResourceRef,
  type LatencyMode,
  type OpenGeniClient,
  type ReasoningEffort,
} from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import type { SessionRealtimeModel } from "@opengeni/sdk/realtime";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { notifyObserver } from "../lib/notify-observer";
import { modelLevelChoice, modelLevelsView, type ModelLevel } from "../model-levels";
import {
  coerceReasoningEffortForModel,
  defaultEffortForModel,
  runnableLatencyModesForModel,
} from "../model-policy";
import { useWorkspaceModelCatalog } from "./use-available-models";
import { useClientConfigFlags } from "./use-client-config-flags";
import {
  FILE_ONLY_MESSAGE_TEXT,
  type ComposerState,
  type InitialComposerDraft,
} from "./use-composer";
import { useFileAttachments } from "./use-file-attachments";
import { useOpenGeniText } from "../messages/runtime";
import type { PendingPrompt } from "../lib/session-startup-timeline";

/** Browser choices, not server-owned agent configuration or authority. */
export type NewConversationCreateOptions = {
  resources?: FileResourceRef[] | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  latencyMode?: LatencyMode | undefined;
  /** Creates an empty session; no synthetic first user message. */
  startMode?: "realtime" | undefined;
};

export type CreatedConversation = {
  sessionId: string;
  /** The accepted first message; empty for voice-first creation. */
  initialMessage: string;
  /**
   * When the person sent it (ISO 8601). With `initialMessage` and `resources`
   * it is the controller's `pendingPrompt`, for a conversation that mounts
   * only now.
   */
  sentAt: string;
  /** The files sent with the first message. */
  resources: FileResourceRef[];
  /** Newer unsent content, or the whole untouched draft for voice-first creation. */
  draft: InitialComposerDraft;
  realtimeModel?: SessionRealtimeModel | undefined;
};

export type UseNewConversationOptions = ClientOverride<ChatClient> & {
  createSession?:
    | ((
        initialMessage: string,
        idempotencyKey: string,
        options: NewConversationCreateOptions,
      ) => Promise<string>)
    | undefined;
  onCreated?: ((created: CreatedConversation) => void) | undefined;
  /** A host may disable creation while its own required state is loading. */
  enabled?: boolean | undefined;
  attachments?: boolean | undefined;
  modelPicker?: boolean | undefined;
  realtimeVoice?: boolean | undefined;
  /** Changes reset this new-chat draft; use for host record/project scope. */
  scopeKey?: string | undefined;
  /**
   * The model to preselect instead of the workspace default, such as an app's
   * configured model. Used only while the catalog offers it as selectable.
   */
  defaultModel?: string | null | undefined;
};

type Choice = Pick<NewConversationCreateOptions, "model" | "reasoningEffort" | "latencyMode">;
type Attempt = {
  key: string;
  initialMessage: string;
  sentAt: string;
  options: NewConversationCreateOptions;
  /** The person's choice when they sent; an unchanged choice is the created session's own. */
  choice: Choice;
  textRevision: number;
  clearDraft: boolean;
  realtimeModel?: SessionRealtimeModel | undefined;
  /** Freeze the host adapter too: its captured context belongs to this attempt. */
  create: NonNullable<UseNewConversationOptions["createSession"]>;
};
type Completion = { sessionId: string; attempt: Attempt; generation: number };
const NOOP_ASYNC = async () => {};
const EMPTY_CHOICE: Choice = {};
const NO_LEVELS: readonly ModelLevel[] = [];

export type NewConversationController = ReturnType<typeof useNewConversation>;

/** Stock new-chat state shared by OpenGeniChat and custom host layouts. */
export function useNewConversation(options: UseNewConversationOptions = {}) {
  const t = useOpenGeniText();
  const context = useOpenGeni(options);
  const scope = { client: context.client, workspaceId: context.workspaceId };
  const config = useClientConfigFlags(context.client);
  const showModelPicker = options.modelPicker ?? config.modelSelection;
  const catalog = useWorkspaceModelCatalog({ ...scope, enabled: showModelPicker });
  // A host's preferred model wins over the workspace default while the
  // workspace can run it; otherwise the server-owned default stands.
  const preferredModel =
    options.defaultModel &&
    catalog.models.some(
      (row) => row.id === options.defaultModel && row.availability?.selectable !== false,
    )
      ? options.defaultModel
      : undefined;
  const defaultModel = preferredModel ?? catalog.defaultModel;
  const files = useFileAttachments(scope);
  const uploadsEnabled = (options.attachments ?? true) && config.uploads;
  const available =
    options.enabled !== false && (options.createSession !== undefined || config.sessionCreation);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState(EMPTY_CHOICE);
  const [, setLevels] = useState(NO_LEVELS);
  const [delivering, setDelivering] = useState<Attempt | null>(null);
  const sending = delivering !== null;
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const textRef = useRef(text);
  const textRevision = useRef(0);
  const choiceRef = useRef(choice);
  const levelsRef = useRef(NO_LEVELS);
  const setModelLevels = useCallback((levels = NO_LEVELS) => {
    const previous = levelsRef.current;
    if (
      previous.length === levels.length &&
      previous.every((level, index) => {
        const next = levels[index];
        return next?.model === level.model && next.effort === level.effort;
      })
    )
      return;
    levelsRef.current = levels;
    setLevels(levels);
  }, []);
  const filesRef = useRef(files);
  filesRef.current = files;
  const pendingRef = useRef<Attempt | null>(null);
  const completionRef = useRef<Completion | null>(null);
  const inFlight = useRef(false);
  const lifetime = useRef({ mounted: true, generation: 0 }).current;
  // An identity value may recur (A → B → A); callbacks from the first A
  // must not become live again. Commit a distinct token for each scope epoch.
  const identity = useMemo(
    () => ({
      client: context.client,
      workspaceId: context.workspaceId,
      scopeKey: options.scopeKey,
    }),
    [context.client, context.workspaceId, options.scopeKey],
  );
  const committedIdentity = useRef(identity);
  useLayoutEffect(() => {
    lifetime.mounted = true;
    return () => {
      lifetime.mounted = false;
      lifetime.generation++;
    };
  }, [lifetime]);
  useLayoutEffect(() => {
    if (committedIdentity.current === identity) return;
    committedIdentity.current = identity;
    lifetime.generation++;
    inFlight.current = false;
    pendingRef.current = null;
    completionRef.current = null;
    textRef.current = "";
    textRevision.current = 0;
    choiceRef.current = EMPTY_CHOICE;
    setText("");
    setChoice(EMPTY_CHOICE);
    setDelivering(null);
    setError(null);
    setPending(null);
    setCompletion(null);
    filesRef.current.clear();
  }, [identity, lifetime]);

  const ownsScope = () => lifetime.mounted && committedIdentity.current === identity;
  const updateText = (value: string) => {
    if (!ownsScope()) return;
    if (value !== textRef.current) textRevision.current++;
    textRef.current = value;
    setText(value);
  };
  const updateChoice = (patch: Choice) => {
    if (!ownsScope()) return;
    // An effort-only or speed-only edit builds on the displayed model. An
    // explicit model does not inherit the effort of an implicit level fallback.
    const base = patch.model === undefined ? creationChoice() : choiceRef.current;
    const next = { ...base, ...patch };
    const model = catalog.models.find((row) => row.id === (next.model ?? defaultModel));
    if (model) {
      if (next.reasoningEffort)
        next.reasoningEffort = coerceReasoningEffortForModel(model, next.reasoningEffort);
      if (next.latencyMode && !runnableLatencyModesForModel(model).includes(next.latencyMode))
        next.latencyMode = "standard";
    }
    choiceRef.current = next;
    setChoice(choiceRef.current);
    // A refusal names what to change; once the person changes it, the stale
    // reason goes. An unconfirmed create keeps its status until it settles.
    if (!pendingRef.current) setError(null);
  };
  const displayPolicy = (selected: Choice) => {
    const model = selected.model ?? defaultModel;
    const definition = catalog.models.find((row) => row.id === model);
    const effort =
      selected.reasoningEffort ??
      (definition
        ? defaultEffortForModel(definition)
        : (config.defaultReasoningEffort ?? "medium"));
    return showModelPicker && model
      ? {
          model,
          reasoningEffort: definition ? coerceReasoningEffortForModel(definition, effort) : effort,
          latencyMode: selected.latencyMode ?? ("standard" as const),
        }
      : undefined;
  };
  const creationChoice = (): Choice => {
    const selected = choiceRef.current;
    // Explicit host defaults and draft edits win. A level fallback is a default,
    // not an edit that can overwrite either of them when a view mounts.
    if (preferredModel) return { model: preferredModel, ...selected };
    if (
      selected !== EMPTY_CHOICE ||
      !showModelPicker ||
      catalog.loading ||
      !levelsRef.current.length
    )
      return selected;
    const workspace = displayPolicy(EMPTY_CHOICE);
    const view = modelLevelsView(t, {
      levels: levelsRef.current,
      rows: catalog.rows,
      model: workspace?.model ?? "",
      effort: workspace?.reasoningEffort ?? "medium",
      latencyMode: "standard",
    });
    const first = view && view.index < 0 ? modelLevelChoice(view, 0, false) : null;
    // Otherwise omit the model from the request and let the server default it.
    return first ? { model: first.model, reasoningEffort: first.effort } : selected;
  };
  const create: Attempt["create"] =
    options.createSession ??
    (async (initialMessage, idempotencyKey, input) => {
      const creator = (
        context.client as unknown as Partial<Pick<ChatClient<OpenGeniClient>, "createSession">>
      ).createSession;
      if (typeof creator !== "function")
        throw new Error(t("hooks.useNewConversation.newChatsAreNotEnabled"));
      const created = await creator.call(context.client, context.workspaceId, {
        ...(input.startMode === "realtime" ? {} : { initialMessage }),
        idempotencyKey,
        ...input,
      } as Parameters<ChatClient<OpenGeniClient>["createSession"]>[1]);
      return created.id;
    });

  const finishCreation = (accepted: Completion) => {
    if (!lifetime.mounted || lifetime.generation !== accepted.generation) return;
    const { attempt, sessionId } = accepted;
    const sentFiles = new Set(attempt.options.resources?.map((resource) => resource.fileId) ?? []);
    const selected = showModelPicker ? creationChoice() : EMPTY_CHOICE;
    // Only an edit made after Send can differ from the created session. The
    // view may be unmounted meanwhile (OpenGeniChat shows the conversation),
    // so its level configuration is not there to re-derive the sent choice.
    const policyChanged =
      choiceRef.current !== attempt.choice &&
      (["model", "reasoningEffort", "latencyMode"] as const).some(
        (field) => selected[field] !== attempt.options[field],
      );
    const draft: InitialComposerDraft = {
      text:
        attempt.clearDraft && textRevision.current === attempt.textRevision ? "" : textRef.current,
      resources: filesRef.current.readyResources.filter(
        (resource) => !sentFiles.has(resource.fileId),
      ),
      // Unchanged choices are already part of the created session. Do not
      // replace server-owned defaults with a browser's catalog estimate.
      ...(policyChanged ? { policy: displayPolicy(selected) } : {}),
    };
    pendingRef.current = null;
    completionRef.current = null;
    setPending(null);
    setCompletion(null);
    updateText(draft.text);
    filesRef.current.removeReadyFiles(sentFiles);
    notifyObserver(options.onCreated, {
      sessionId,
      initialMessage: attempt.initialMessage,
      sentAt: attempt.sentAt,
      resources: attempt.options.resources ?? [],
      draft,
      ...(attempt.realtimeModel ? { realtimeModel: attempt.realtimeModel } : {}),
    });
  };
  const finishRef = useRef(finishCreation);
  finishRef.current = finishCreation;
  useLayoutEffect(() => {
    if (completion && !files.hasUnresolved) finishRef.current(completion);
  }, [completion, files.hasUnresolved]);

  const deliver = async (attempt: Attempt): Promise<boolean> => {
    if (!ownsScope() || inFlight.current || completionRef.current || !available) return false;
    const ownedGeneration = lifetime.generation;
    inFlight.current = true;
    pendingRef.current = attempt;
    setDelivering(attempt);
    setError(null);
    setPending(null);
    try {
      const sessionId = await attempt.create(
        attempt.initialMessage,
        attempt.key,
        structuredClone(attempt.options),
      );
      // Creation still succeeded, but navigation must not seize a different
      // scope's composer or selection when the original host is gone.
      if (!lifetime.mounted || lifetime.generation !== ownedGeneration) return true;
      const accepted = { sessionId, attempt, generation: ownedGeneration };
      completionRef.current = accepted;
      // The user may attach more files while creation is in flight. Keep this
      // composer until those cards resolve or are removed, then hand off their
      // durable references. Never lose browser-local upload bytes on navigation.
      if (filesRef.current.hasUnresolved) setCompletion(accepted);
      else finishCreation(accepted);
      return true;
    } catch (cause) {
      if (!lifetime.mounted || lifetime.generation !== ownedGeneration) return false;
      setError({ cause });
      if (cause instanceof OpenGeniApiError && cause.outcomeUnknown === false) {
        pendingRef.current = null;
      } else {
        // Unknown transport outcomes retain the exact key, payload and host
        // adapter. Editing the next draft must never mint a second session.
        setPending(attempt);
      }
      return false;
    } finally {
      if (lifetime.mounted && lifetime.generation === ownedGeneration) {
        inFlight.current = false;
        setDelivering(null);
      }
    }
  };
  const submit = async (explicit?: string): Promise<boolean> => {
    if (
      !ownsScope() ||
      !available ||
      inFlight.current ||
      pendingRef.current ||
      (uploadsEnabled && filesRef.current.hasUnresolved)
    )
      return false;
    const resources = uploadsEnabled ? filesRef.current.readyResources : [];
    const draftText = explicit ?? textRef.current;
    const initialMessage =
      draftText.trim() || (resources.length > 0 ? FILE_ONLY_MESSAGE_TEXT(t) : "");
    if (!initialMessage) return false;
    return deliver({
      key: crypto.randomUUID(),
      initialMessage,
      sentAt: new Date().toISOString(),
      choice: choiceRef.current,
      textRevision: textRevision.current,
      clearDraft: explicit === undefined,
      create,
      options: {
        ...(resources.length ? { resources: structuredClone(resources) } : {}),
        ...(showModelPicker ? creationChoice() : {}),
      },
    });
  };
  const startRealtime = async (model: SessionRealtimeModel): Promise<boolean> => {
    if (
      !ownsScope() ||
      !available ||
      inFlight.current ||
      pendingRef.current ||
      !config.realtimeVoice ||
      !(options.realtimeVoice ?? config.realtimeVoiceOffered)
    )
      return false;
    if (filesRef.current.hasUnresolved) return false;
    return deliver({
      key: crypto.randomUUID(),
      initialMessage: "",
      sentAt: new Date().toISOString(),
      choice: choiceRef.current,
      textRevision: textRevision.current,
      clearDraft: false,
      create,
      options: {
        ...(showModelPicker ? creationChoice() : {}),
        startMode: "realtime",
      },
      realtimeModel: model,
    });
  };
  // The first message from Send until `onCreated` or failure, including while
  // the person's newer uploads finish. Voice-first creation has none.
  const promptAttempt = delivering ?? completion?.attempt ?? null;
  const pendingPrompt = useMemo(
    (): PendingPrompt | null =>
      promptAttempt && promptAttempt.options.startMode !== "realtime"
        ? {
            text: promptAttempt.initialMessage,
            sentAt: promptAttempt.sentAt,
            ...(promptAttempt.options.resources?.length
              ? { resources: promptAttempt.options.resources }
              : {}),
          }
        : null,
    [promptAttempt],
  );
  const composer: ComposerState = {
    value: text,
    setValue: updateText,
    hasDraftContent: () => textRef.current.length > 0 || filesRef.current.attachments.length > 0,
    send: submit,
    steer: submit,
    // Nothing runs before the conversation exists: Send just sends.
    working: false,
    sending,
    canSend:
      available &&
      !sending &&
      !pending &&
      !completion &&
      (text.trim().length > 0 || (uploadsEnabled && files.readyResources.length > 0)) &&
      !(uploadsEnabled && files.hasUnresolved),
    pause: NOOP_ASYNC,
    pausing: false,
    resume: NOOP_ASYNC,
    resumeScope: NOOP_ASYNC,
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    policy: displayPolicy(creationChoice()) ?? null,
    setModel: (model) => updateChoice({ model }),
    setReasoningEffort: (reasoningEffort) => updateChoice({ reasoningEffort }),
    setLatencyMode: (latencyMode) => updateChoice({ latencyMode }),
    draftPersistence: "disabled",
    applyDraft: () => {},
    reloadDraft: NOOP_ASYNC,
    resolveDraftConflict: NOOP_ASYNC,
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {
      if (ownsScope()) setError(null);
    },
  };
  return {
    ...scope,
    config,
    files,
    uploadsEnabled,
    available,
    showModelPicker,
    setModelLevels,
    setModelPolicy: updateChoice,
    catalog,
    composer,
    realtimeVoiceEnabled:
      config.realtimeVoice && (options.realtimeVoice ?? config.realtimeVoiceOffered),
    error,
    finishingUploads: completion !== null,
    /**
     * The first message while its chat is being created: from the frame Send
     * starts until `onCreated` or a failure. Render the conversation with
     * `sessionId={null}` and this `pendingPrompt`, then pass the id from
     * `onCreated`; on failure show this new-chat view again, with its draft,
     * error and Retry.
     */
    pendingPrompt,
    pending: pending ? { idempotencyKey: pending.key, realtimeModel: pending.realtimeModel } : null,
    retry: () => (pendingRef.current ? deliver(pendingRef.current) : Promise.resolve(false)),
    startRealtime,
  };
}
