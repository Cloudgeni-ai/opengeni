/**
 * Platform-neutral session realtime: the controller hook, admission rules and
 * the workspace voice-model catalog. Free of DOM components, so web and native
 * hosts (which inject their own WebRTC through `controllerFactory`) share it.
 */
import { type EffectiveSessionControl, type SessionEvent, type SessionStatus } from "@opengeni/sdk";
import {
  hasStoredSessionRealtimeOwnerProof,
  isSessionRealtimeModel,
  projectSessionRealtimeLifecycle,
  type CreateSessionRealtimeControllerOptions,
  type SessionRealtimeClientLike,
  type SessionRealtimeController,
  type SessionRealtimeControllerSnapshot,
  type SessionRealtimeLifecycleProjection,
  type RealtimeVoiceSettings,
  type SessionRealtimeModel,
  type WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/sdk/realtime";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EmbeddedRealtimeSessionClientLike } from "../client";
import { useEmbeddedRealtimeSession } from "../session-context";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

/** An abort reason that works where DOMException is missing (React Native). */
function abortError(message: string): Error {
  if (typeof DOMException !== "undefined") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export type RealtimeModelOption = {
  id: SessionRealtimeModel;
  label: string;
  provider: WorkspaceRealtimeModelCatalogItem["provider"];
  description: string;
  available: boolean;
  unavailableReason: string | null;
  /** Machine-readable reason, e.g. `insufficient_credits` (same codes as voice input). */
  unavailableCode?: string | null | undefined;
  recommended: boolean;
  /**
   * Languages a conversation with this model can be set to. Absent when the
   * model detects the spoken language itself.
   */
  languages?: readonly string[] | undefined;
  /** Voices this model can speak with. Absent when the voice cannot be chosen. */
  voices?: WorkspaceRealtimeModelCatalogItem["voices"];
  /** Whether any provider voice id is accepted beyond the listed `voices`. */
  customVoice?: boolean | undefined;
  /** Turn eagerness values this model accepts. */
  turnEagerness?: WorkspaceRealtimeModelCatalogItem["turnEagerness"];
  /** The provider's defaults for the settings it offers, other than language. */
  voiceDefaults?: RealtimeVoiceSettings | undefined;
  /** The workspace's saved voice settings for this model. */
  workspaceVoiceSettings?: RealtimeVoiceSettings | undefined;
  /** True on the model the workspace chose to start voice conversations with. */
  workspaceDefault?: boolean | undefined;
  /** True on the model the organization chose; the workspace's own choice wins. */
  organizationDefault?: boolean | undefined;
};

export const CODEX_LIVE_MODEL = (t: OpenGeniText): RealtimeModelOption => ({
  id: "gpt-live-1-boulder-alpha",
  label: t("realtime.sessionRealtime.codexLive"),
  provider: "Connected Codex",
  description: t("realtime.sessionRealtime.deepSessionIntegration"),
  available: false,
  unavailableReason: t("realtime.sessionRealtime.connectCodexToUseThis"),
  recommended: false,
});

const REALTIME_MODEL_STORAGE_PREFIX = "opengeni:realtime-model";
const REALTIME_LANGUAGE_STORAGE_KEY = "opengeni:realtime-language";
const REALTIME_MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const REALTIME_MODEL_CATALOG_CACHE_MAX_WORKSPACES = 64;

export type RealtimeControllerClient = EmbeddedRealtimeSessionClientLike &
  SessionRealtimeClientLike;

const realtimeLanguageListeners = new Set<() => void>();
let realtimeLanguageMemory: string | null = null;

function readRealtimeLanguagePreference(): string | null {
  if (typeof localStorage === "undefined") return realtimeLanguageMemory;
  try {
    return localStorage.getItem(REALTIME_LANGUAGE_STORAGE_KEY) ?? null;
  } catch {
    return realtimeLanguageMemory;
  }
}

function subscribeRealtimeLanguagePreference(listener: () => void): () => void {
  realtimeLanguageListeners.add(listener);
  return () => realtimeLanguageListeners.delete(listener);
}

/**
 * The person's chosen voice-conversation language (a catalog language code), or
 * `null` to follow their app language. Kept on this device for every workspace.
 */
export function useRealtimeLanguagePreference(): {
  language: string | null;
  setLanguage(language: string | null): void;
} {
  const language = useSyncExternalStore(
    subscribeRealtimeLanguagePreference,
    readRealtimeLanguagePreference,
    () => null,
  );
  const setLanguage = useCallback((next: string | null) => {
    realtimeLanguageMemory = next;
    if (typeof localStorage !== "undefined") {
      try {
        if (next === null) localStorage.removeItem(REALTIME_LANGUAGE_STORAGE_KEY);
        else localStorage.setItem(REALTIME_LANGUAGE_STORAGE_KEY, next);
      } catch {
        // The choice still applies on this page when browser storage is unavailable.
      }
    }
    for (const listener of realtimeLanguageListeners) listener();
  }, []);
  return { language, setLanguage };
}

/** The person's app language: the host locale, else the browser's language. */
export function realtimeAppLanguage(locale: string | undefined): string | undefined {
  if (locale) return locale;
  return typeof navigator === "undefined" ? undefined : navigator.language || undefined;
}

/**
 * The language a voice conversation with `model` is held in: the person's
 * choice, else their app language. Undefined for models that detect the spoken
 * language themselves, so nothing is sent for them.
 */
export function realtimeConversationLanguage(
  model: Pick<RealtimeModelOption, "languages"> | undefined,
  preference: string | null,
  locale: string | undefined,
): string | undefined {
  if (!model?.languages?.length) return undefined;
  return preference ?? realtimeAppLanguage(locale);
}

type RealtimeModelCatalogCacheEntry =
  | {
      state: "loading";
      promise: Promise<RealtimeModelOption[]>;
      controller: AbortController;
      consumers: number;
    }
  | { state: "ready"; models: RealtimeModelOption[]; expiresAt: number };

// Scope advisory availability to the exact client object and workspace. The
// server still authorizes every realtime operation; changing principals should
// replace the client just as it does for the rest of the SDK state.
const realtimeModelCatalogCache = new WeakMap<
  RealtimeControllerClient,
  Map<string, RealtimeModelCatalogCacheEntry>
>();

function realtimeModelFallback(t: OpenGeniText, codexConnected: boolean): RealtimeModelOption[] {
  return [
    {
      ...CODEX_LIVE_MODEL(t),
      available: codexConnected,
      unavailableReason: codexConnected ? null : CODEX_LIVE_MODEL(t).unavailableReason,
    },
  ];
}

function realtimeModelCatalogCacheFor(
  client: RealtimeControllerClient,
): Map<string, RealtimeModelCatalogCacheEntry> {
  const existing = realtimeModelCatalogCache.get(client);
  if (existing) return existing;
  const created = new Map<string, RealtimeModelCatalogCacheEntry>();
  realtimeModelCatalogCache.set(client, created);
  return created;
}

function readCachedRealtimeModelCatalog(
  client: RealtimeControllerClient,
  workspaceId: string,
  now = Date.now(),
): RealtimeModelOption[] | null {
  const cache = realtimeModelCatalogCache.get(client);
  const entry = cache?.get(workspaceId);
  if (!entry || entry.state === "loading") return null;
  if (entry.expiresAt > now) return entry.models;
  cache?.delete(workspaceId);
  return null;
}

function pruneRealtimeModelCatalogCache(
  cache: Map<string, RealtimeModelCatalogCacheEntry>,
  now: number,
): void {
  for (const [workspaceId, entry] of cache) {
    if (entry.state === "ready" && entry.expiresAt <= now) cache.delete(workspaceId);
  }
  while (cache.size >= REALTIME_MODEL_CATALOG_CACHE_MAX_WORKSPACES) {
    const oldestWorkspaceId = cache.keys().next().value;
    if (oldestWorkspaceId === undefined) return;
    cache.delete(oldestWorkspaceId);
  }
}

/** Shared by the lazy conversation offer and the stock voice control. */
export function loadRealtimeModelCatalog(
  client: RealtimeControllerClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<RealtimeModelOption[]> | null {
  const load = client.getWorkspaceRealtimeModelCatalog;
  if (!load) return null;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? abortError("Request aborted"));
  }
  const now = Date.now();
  const cache = realtimeModelCatalogCacheFor(client);
  const entry = cache.get(workspaceId);
  if (entry?.state === "loading" && !entry.controller.signal.aborted) {
    return consumeRealtimeModelCatalog(entry, signal);
  }
  if (entry?.state === "ready" && entry.expiresAt > now) return Promise.resolve(entry.models);
  if (entry) cache.delete(workspaceId);
  pruneRealtimeModelCatalogCache(cache, now);

  const controller = new AbortController();
  const promise = load
    .call(client, workspaceId, { signal: controller.signal })
    .then((response) => response.models.map(toRealtimeModelOption))
    .then((models) => {
      const current = cache.get(workspaceId);
      if (current?.state === "loading" && current.promise === promise) {
        cache.delete(workspaceId);
        cache.set(workspaceId, {
          state: "ready",
          models,
          expiresAt: Date.now() + REALTIME_MODEL_CATALOG_CACHE_TTL_MS,
        });
      }
      return models;
    })
    .catch((error: unknown) => {
      const current = cache.get(workspaceId);
      if (current?.state === "loading" && current.promise === promise) cache.delete(workspaceId);
      throw error;
    });
  const loading: RealtimeModelCatalogCacheEntry & { state: "loading" } = {
    state: "loading",
    promise,
    controller,
    consumers: 0,
  };
  cache.set(workspaceId, loading);
  return consumeRealtimeModelCatalog(loading, signal);
}

function consumeRealtimeModelCatalog(
  entry: RealtimeModelCatalogCacheEntry & { state: "loading" },
  signal?: AbortSignal,
): Promise<RealtimeModelOption[]> {
  entry.consumers += 1;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (abandoned: boolean) => {
      if (released) return;
      released = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (abandoned && entry.consumers === 0) {
        entry.controller.abort(signal?.reason ?? abortError("Request abandoned"));
      }
    };
    const onAbort = () => {
      release(true);
      reject(signal?.reason ?? abortError("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void entry.promise.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      release(false);
    });
  });
}

export type SessionRealtimeControllerFactory = (
  options: CreateSessionRealtimeControllerOptions,
) => SessionRealtimeController;

type PrestartedSessionRealtime = {
  model: SessionRealtimeModel;
  controller: Promise<SessionRealtimeController>;
  /** Filled in by the session view that adopts the call. */
  modelContext: { current: (() => string | undefined) | undefined };
  /** The conversation language; the adopting view takes it over. */
  language: { current: () => string | undefined };
  /** The voice settings; the adopting view takes them over. */
  voiceSettings: { current: () => RealtimeVoiceSettings | undefined };
};

const prestartedSessionRealtime = new Map<string, PrestartedSessionRealtime>();
/** Calls being ended after their host abandoned them, per session. */
const abandonedSessionRealtime = new Map<string, Promise<void>>();

function prestartKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/**
 * Start voice for a session the host has just created, before its session view
 * mounts. The connection comes up while the host navigates, and the view's
 * `useSessionRealtime` (with the same workspace, session and model) adopts the
 * running call instead of starting another. Call it from the action that
 * created the session, so the microphone prompt follows the user's gesture.
 *
 * Returns `abandon`, which ends the call if no view adopted it yet (for
 * example when navigation to the session failed).
 */
export function prestartSessionRealtime(input: {
  client: RealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  model: SessionRealtimeModel;
  /**
   * BCP 47 language the conversation is held in, for models that need one
   * (see `realtimeConversationLanguage`).
   */
  language?: string | undefined;
  /**
   * Voice settings for this call (voice, language, turn eagerness), over the
   * workspace's saved settings for the model.
   */
  voiceSettings?: RealtimeVoiceSettings | undefined;
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}): () => void {
  const key = prestartKey(input.workspaceId, input.sessionId);
  const existing = prestartedSessionRealtime.get(key);
  // A retried handoff keeps the call already starting for the same model.
  if (existing?.model === input.model) return abandonPrestarted(key, existing);
  if (existing) abandonPrestarted(key, existing)();
  const modelContext: PrestartedSessionRealtime["modelContext"] = { current: undefined };
  const language: PrestartedSessionRealtime["language"] = { current: () => input.language };
  const voiceSettings: PrestartedSessionRealtime["voiceSettings"] = {
    current: () => input.voiceSettings,
  };
  // An abandoned call for this session ends before the next one begins.
  const controller = (abandonedSessionRealtime.get(key) ?? Promise.resolve())
    .then(() => import("@opengeni/sdk/realtime"))
    .then(({ createSessionRealtimeController }) => {
      const created = (input.controllerFactory ?? createSessionRealtimeController)({
        client: input.client,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        // The adopting view's audio element does not exist yet; a detached
        // element plays the same way.
        ...(typeof Audio === "undefined" ? {} : { remoteAudio: new Audio() }),
        model: input.model,
        getModelContext: () => modelContext.current?.(),
        getLanguage: () => language.current(),
        getVoiceSettings: () => voiceSettings.current(),
      });
      // The call's state (including a failed start) is read from the
      // controller by the view that adopts it.
      void created.start().catch(() => undefined);
      return created;
    });
  const entry: PrestartedSessionRealtime = {
    model: input.model,
    controller,
    modelContext,
    language,
    voiceSettings,
  };
  prestartedSessionRealtime.set(key, entry);
  controller.catch(() => {
    if (prestartedSessionRealtime.get(key) === entry) prestartedSessionRealtime.delete(key);
  });
  return abandonPrestarted(key, entry);
}

function abandonPrestarted(key: string, entry: PrestartedSessionRealtime): () => void {
  return () => {
    if (prestartedSessionRealtime.get(key) !== entry) return;
    prestartedSessionRealtime.delete(key);
    const ended = entry.controller.then(
      (abandoned) =>
        abandoned
          .stop()
          .catch(() => undefined)
          .finally(() => abandoned.close()),
      () => undefined,
    );
    abandonedSessionRealtime.set(key, ended);
    void ended.finally(() => {
      if (abandonedSessionRealtime.get(key) === ended) abandonedSessionRealtime.delete(key);
    });
  };
}

type AdmissionInput = {
  sessionStatus: SessionStatus;
  controlState: "active" | "paused";
  settlement: { state: string } | null;
  codexConnected: boolean;
  lifecycleActive: boolean;
};

export function codexRealtimeAdmissionAllowed(t: OpenGeniText, input: AdmissionInput): boolean {
  return codexRealtimeAdmissionBlocker(t, input) === null;
}

export function codexRealtimeAdmissionBlocker(
  t: OpenGeniText,
  input: AdmissionInput,
): string | null {
  if (input.sessionStatus === "cancelled")
    return t("realtime.sessionRealtime.thisSessionWasCancelled");
  if (input.controlState !== "active")
    return t("realtime.sessionRealtime.resumeThisSessionBeforeStarting");
  if (input.settlement !== null) return t("realtime.sessionRealtime.waitForTheCurrentSession");
  if (!input.codexConnected) return t("realtime.sessionRealtime.connectCodexToUseThis2");
  if (input.lifecycleActive) return t("realtime.sessionRealtime.voiceIsAlreadyActiveFor");
  return null;
}

export function useSessionRealtime(options: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
  model?: SessionRealtimeModel | undefined;
  modelAvailable?: boolean | undefined;
  modelUnavailableReason?: string | null | undefined;
  /** Model-visible application context captured with each durable realtime message. */
  getModelContext?: (() => string | undefined) | undefined;
  /**
   * BCP 47 language the conversation is held in, for models that need one
   * (see `realtimeConversationLanguage`). Applies from the next connection.
   */
  language?: string | undefined;
  /**
   * Voice settings (voice, language, turn eagerness) over the workspace's saved
   * settings for the model. Applies from the next connection.
   */
  voiceSettings?: RealtimeVoiceSettings | undefined;
  /** Deterministic browser-test/demo seam. Production hosts should use the SDK default. */
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}) {
  const t = useOpenGeniText();
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const model = options.model ?? CODEX_LIVE_MODEL(t).id;
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<SessionRealtimeController | null>(null);
  const controllerModelRef = useRef<SessionRealtimeModel | null>(null);
  const modelContextProviderRef = useRef(options.getModelContext);
  modelContextProviderRef.current = options.getModelContext;
  const languageRef = useRef(options.language);
  languageRef.current = options.language;
  const voiceSettingsRef = useRef(options.voiceSettings);
  voiceSettingsRef.current = options.voiceSettings;
  const [snapshot, setSnapshot] = useState<SessionRealtimeControllerSnapshot>(() => ({
    status: hasStoredSessionRealtimeOwnerProof({
      workspaceId,
      sessionId: options.sessionId,
      model,
    })
      ? "recovering"
      : "idle",
    realtimeId: null,
    mode: null,
    bridge: null,
    microphone: "inactive",
    inputMuted: false,
    audibleOutput: "inactive",
    outputMuted: false,
    connectionGeneration: 0,
    reconnectAttempt: 0,
    diagnostic: null,
    error: null,
  }));
  const lifecycle = useMemo(
    () => projectSessionRealtimeLifecycle(options.events),
    [options.events],
  );
  const lifecycleRef = useRef(lifecycle);
  const eventsReadyRef = useRef(options.eventsReady);
  lifecycleRef.current = lifecycle;
  eventsReadyRef.current = options.eventsReady;
  const lifecycleActive = sessionRealtimeLifecycleIsActive(lifecycle);
  const [prestarted, setPrestarted] = useState(false);

  useEffect(() => {
    let disposed = false;
    let controller: SessionRealtimeController | null = null;
    let unsubscribe: (() => void) | null = null;
    const key = prestartKey(workspaceId, options.sessionId);
    const adopted = prestartedSessionRealtime.get(key);
    // A call started before this view mounted owns the session's voice. Wait
    // for the selection to reach its model rather than racing it with another
    // controller.
    if (adopted && adopted.model !== model) return;
    if (adopted) {
      prestartedSessionRealtime.delete(key);
      adopted.modelContext.current = () => modelContextProviderRef.current?.();
      adopted.language.current = () => languageRef.current;
      adopted.voiceSettings.current = () => voiceSettingsRef.current;
    }
    const pending: Promise<SessionRealtimeController | null> = adopted
      ? adopted.controller
      : import("@opengeni/sdk/realtime").then(({ createSessionRealtimeController }) => {
          if (disposed) return null;
          const controllerFactory = options.controllerFactory ?? createSessionRealtimeController;
          return controllerFactory({
            client,
            workspaceId,
            sessionId: options.sessionId,
            ...(audioRef.current ? { remoteAudio: audioRef.current } : {}),
            model,
            getModelContext: () => modelContextProviderRef.current?.(),
            getLanguage: () => languageRef.current,
            getVoiceSettings: () => voiceSettingsRef.current,
          });
        });
    void pending
      .then((created) => {
        if (!created) return;
        if (disposed) {
          created.close();
          return;
        }
        controller = created;
        controllerRef.current = controller;
        controllerModelRef.current = model;
        setPrestarted(adopted !== undefined);
        unsubscribe = controller.subscribe(setSnapshot);
        if (eventsReadyRef.current) {
          void controller.observeLifecycle(lifecycleRef.current).catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setSnapshot({
          status: "error",
          realtimeId: null,
          mode: null,
          bridge: null,
          microphone: "inactive",
          inputMuted: false,
          audibleOutput: "inactive",
          outputMuted: false,
          connectionGeneration: 0,
          reconnectAttempt: 0,
          diagnostic: {
            kind: "negotiation_failure",
            message:
              error instanceof Error
                ? error.message
                : t("realtime.sessionRealtime.codexRealtimeControllerFailedTo"),
            recoverable: false,
            connectionGeneration: 0,
            attempt: 0,
          },
          error:
            error instanceof Error
              ? error.message
              : t("realtime.sessionRealtime.codexRealtimeControllerFailedTo"),
        });
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      controller?.close();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        controllerModelRef.current = null;
      }
    };
  }, [client, model, options.controllerFactory, options.sessionId, workspaceId, t]);

  useEffect(() => {
    if (!options.eventsReady) return;
    void controllerRef.current?.observeLifecycle(lifecycle).catch(() => undefined);
  }, [lifecycle, options.eventsReady]);

  // A delegated turn's result reaches the voice model through the realtime
  // ledger. Pull it as soon as the session reports the turn's outcome instead
  // of waiting for the next periodic sync.
  const delegationOutcomeSequence = useMemo(
    () => latestDelegationOutcomeSequence(options.events),
    [options.events],
  );
  const flushedOutcomeSequenceRef = useRef(delegationOutcomeSequence);
  useEffect(() => {
    if (delegationOutcomeSequence <= flushedOutcomeSequenceRef.current) return;
    flushedOutcomeSequenceRef.current = delegationOutcomeSequence;
    void controllerRef.current?.flush().catch(() => undefined);
  }, [delegationOutcomeSequence]);

  const start = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || controllerModelRef.current !== model) {
      throw new Error(t("realtime.sessionRealtime.theSelectedVoiceModelIs"));
    }
    await controller.start();
  }, [model, t]);
  const stop = useCallback(async () => {
    await controllerRef.current?.stop();
  }, []);
  const retry = useCallback(async () => {
    await controllerRef.current?.retry();
  }, []);
  const retryAudibleOutput = useCallback(async () => {
    await controllerRef.current?.retryAudibleOutput();
  }, []);
  const setInputMuted = useCallback((muted: boolean) => {
    controllerRef.current?.setInputMuted(muted);
  }, []);
  const setOutputMuted = useCallback((muted: boolean) => {
    controllerRef.current?.setOutputMuted(muted);
  }, []);
  const admissionInput = {
    sessionStatus: options.sessionStatus,
    controlState: options.effectiveControl.state,
    settlement: options.effectiveControl.settlement,
    codexConnected: options.modelAvailable ?? options.codexConnected,
    lifecycleActive,
  } satisfies AdmissionInput;
  const admissionBlocker =
    options.modelAvailable === false
      ? (options.modelUnavailableReason ??
        t("realtime.sessionRealtime.thisVoiceModelIsUnavailable"))
      : codexRealtimeAdmissionBlocker(t, admissionInput);
  const canStart =
    controllerRef.current !== null &&
    controllerModelRef.current === model &&
    ["idle", "error"].includes(snapshot.status) &&
    admissionBlocker === null;

  return {
    snapshot,
    lifecycleActive,
    /** The current call was started before this view mounted and adopted here. */
    prestarted,
    canStart,
    admissionBlocker,
    codexConnected: options.codexConnected,
    audioRef,
    start,
    stop,
    retry,
    retryAudibleOutput,
    setInputMuted,
    setOutputMuted,
  };
}

const DELEGATION_OUTCOME_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.message.completed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

/** The newest event that can settle a delegated turn's spoken result. */
function latestDelegationOutcomeSequence(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (DELEGATION_OUTCOME_EVENT_TYPES.has(event.type)) return event.sequence;
  }
  return 0;
}

export function sessionRealtimeLifecycleIsActive(
  lifecycle: SessionRealtimeLifecycleProjection | null,
): boolean {
  if (lifecycle?.state !== "active") return false;
  const leaseExpiresAt = Date.parse(lifecycle.leaseExpiresAt);
  return !Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.now();
}

/**
 * First available model; otherwise the model whose blocker the user can act on
 * (for example adding credits) rather than an unrelated "connect" prompt.
 */
function fallbackRealtimeModelId(
  t: OpenGeniText,
  models: readonly RealtimeModelOption[],
): SessionRealtimeModel {
  return (
    models.find((model) => model.available)?.id ??
    models.find((model) => model.unavailableCode)?.id ??
    CODEX_LIVE_MODEL(t).id
  );
}

/**
 * The model a voice conversation starts with: the person's own pick when they
 * can use it, else the model the workspace (or else its organization) chose,
 * else Codex Live, else the first model they can use.
 */
function startingRealtimeModelId(
  t: OpenGeniText,
  models: readonly RealtimeModelOption[],
  picked: SessionRealtimeModel | null,
): SessionRealtimeModel {
  const usable = (id: SessionRealtimeModel) =>
    models.some((model) => model.id === id && model.available);
  if (picked && usable(picked)) return picked;
  const chosen =
    models.find((model) => model.workspaceDefault) ??
    models.find((model) => model.organizationDefault);
  if (chosen?.available) return chosen.id;
  // A pick the person can no longer use falls to the first usable model.
  if (!picked && usable(CODEX_LIVE_MODEL(t).id)) return CODEX_LIVE_MODEL(t).id;
  return fallbackRealtimeModelId(t, models);
}

export function useRealtimeModelSelection(options: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  codexConnected: boolean;
  activeModel?: SessionRealtimeModel | null | undefined;
}) {
  const t = useOpenGeniText();
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const activeModel = options.activeModel;
  const initialCachedCatalog = readCachedRealtimeModelCatalog(client, workspaceId);
  const [catalog, setCatalog] = useState<RealtimeModelOption[]>(
    () => initialCachedCatalog ?? realtimeModelFallback(t, options.codexConnected),
  );
  const catalogScopeRef = useRef({
    client,
    workspaceId,
    source: initialCachedCatalog ? ("cache" as const) : ("fallback" as const),
  });
  // Set when no real catalog will come (no loader, or loading failed): the
  // fallback is then the catalog.
  const [fallbackFinal, setFallbackFinal] = useState<{
    client: unknown;
    workspaceId: string;
  } | null>(null);
  // A pick made here, for when browser storage can't keep it.
  const pickedRef = useRef<{ workspaceId: string; model: SessionRealtimeModel } | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<SessionRealtimeModel>(() => {
    const picked = readRealtimeModelPreference(workspaceId);
    if (!initialCachedCatalog) return picked ?? CODEX_LIVE_MODEL(t).id;
    return startingRealtimeModelId(t, initialCachedCatalog, picked);
  });

  useEffect(() => {
    let disposed = false;
    const requestAbort = new AbortController();
    const applyCatalog = (models: RealtimeModelOption[]) => {
      catalogScopeRef.current = { client, workspaceId, source: "cache" };
      setCatalog(models);
      const picked =
        readRealtimeModelPreference(workspaceId) ??
        (pickedRef.current?.workspaceId === workspaceId ? pickedRef.current.model : null);
      setSelectedModelId(startingRealtimeModelId(t, models, picked));
    };
    const cached = readCachedRealtimeModelCatalog(client, workspaceId);
    if (cached) {
      const scope = catalogScopeRef.current;
      if (
        scope.client !== client ||
        scope.workspaceId !== workspaceId ||
        scope.source !== "cache"
      ) {
        applyCatalog(cached);
      }
      return;
    }
    const loading = loadRealtimeModelCatalog(client, workspaceId, requestAbort.signal);
    if (!loading) {
      setFallbackFinal({ client, workspaceId });
      return;
    }
    void loading
      .then((models) => {
        if (disposed) return;
        applyCatalog(models);
      })
      .catch(() => {
        if (!disposed) setFallbackFinal({ client, workspaceId });
      });
    return () => {
      disposed = true;
      requestAbort.abort();
    };
  }, [client, workspaceId, t]);

  useEffect(() => {
    if (activeModel) setSelectedModelId(activeModel);
  }, [activeModel]);

  const selectedModel =
    catalog.find((model) => model.id === selectedModelId) ??
    ({
      ...CODEX_LIVE_MODEL(t),
      available: options.codexConnected,
      unavailableReason: options.codexConnected ? null : CODEX_LIVE_MODEL(t).unavailableReason,
    } satisfies RealtimeModelOption);
  const selectModel = useCallback(
    (value: string) => {
      const model = catalog.find((candidate) => candidate.id === value);
      if (!model || !model.available || activeModel) return;
      setSelectedModelId(model.id);
      pickedRef.current = { workspaceId, model: model.id };
      writeRealtimeModelPreference(workspaceId, model.id);
    },
    [activeModel, catalog, workspaceId],
  );
  const { language: languagePreference } = useRealtimeLanguagePreference();
  /**
   * The person's own language to send when starting voice with `modelId`: the
   * fallback when neither they nor the workspace chose a conversation language.
   */
  const languageFor = useCallback(
    (modelId: SessionRealtimeModel) =>
      realtimeConversationLanguage(
        catalog.find((model) => model.id === modelId),
        null,
        t.locale,
      ),
    [catalog, t.locale],
  );
  /**
   * The voice settings to send when starting voice with `modelId`: the host's
   * `base` settings, with the language the person picked in the voice menu on
   * top. The workspace's saved settings apply on the server under these.
   */
  const voiceSettingsFor = useCallback(
    (
      modelId: SessionRealtimeModel,
      base?: RealtimeVoiceSettings | undefined,
    ): RealtimeVoiceSettings | undefined => {
      const picked =
        languagePreference !== null &&
        catalog.find((model) => model.id === modelId)?.languages?.length
          ? languagePreference
          : null;
      if (picked === null) return base;
      return { ...base, language: picked };
    },
    [catalog, languagePreference],
  );

  // The fallback catalog is a placeholder: a caller that starts voice on its own
  // (a call from outside the app) waits for the real one, or the selection
  // would change under the starting connection.
  const scope = catalogScopeRef.current;
  const catalogReady =
    (scope.source === "cache" && scope.client === client && scope.workspaceId === workspaceId) ||
    (fallbackFinal?.client === client && fallbackFinal.workspaceId === workspaceId);
  return {
    models: catalog,
    selectedModel,
    selectModel,
    catalogReady,
    languageFor,
    voiceSettingsFor,
  };
}

function toRealtimeModelOption(model: WorkspaceRealtimeModelCatalogItem): RealtimeModelOption {
  return { ...model };
}

function readRealtimeModelPreference(workspaceId: string): SessionRealtimeModel | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(`${REALTIME_MODEL_STORAGE_PREFIX}:${workspaceId}`);
    return isSessionRealtimeModel(value) ? value : null;
  } catch {
    return null;
  }
}

function writeRealtimeModelPreference(workspaceId: string, model: SessionRealtimeModel): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${REALTIME_MODEL_STORAGE_PREFIX}:${workspaceId}`, model);
  } catch {
    // Voice selection still works when browser storage is unavailable.
  }
}
