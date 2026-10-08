/**
 * Platform-neutral session realtime: the controller hook, admission rules and
 * the workspace voice-model catalog. Free of DOM components, so web and native
 * hosts (which inject their own WebRTC through `controllerFactory`) share it.
 */
import { type EffectiveSessionControl, type SessionEvent, type SessionStatus } from "@opengeni/sdk";
import {
  hasStoredSessionRealtimeOwnerProof,
  projectSessionRealtimeLifecycle,
  type CreateSessionRealtimeControllerOptions,
  type SessionRealtimeClientLike,
  type SessionRealtimeController,
  type SessionRealtimeControllerSnapshot,
  type SessionRealtimeLifecycleProjection,
  type SessionRealtimeModel,
  type WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/sdk/realtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EmbeddedRealtimeSessionClientLike } from "../client";
import { useEmbeddedRealtimeSession } from "../session-context";

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
  provider: "OpenGeni" | "Connected Codex" | "Connected SuperGrok" | "Your Gateway";
  description: string;
  available: boolean;
  unavailableReason: string | null;
  /** Machine-readable reason, e.g. `insufficient_credits` (same codes as voice input). */
  unavailableCode?: string | null | undefined;
  recommended: boolean;
};

export const CODEX_LIVE_MODEL: RealtimeModelOption = {
  id: "gpt-live-1-boulder-alpha",
  label: "Codex Live",
  provider: "Connected Codex",
  description: "Deep session integration",
  available: false,
  unavailableReason: "Connect Codex to use this voice model",
  recommended: false,
};

const REALTIME_MODEL_STORAGE_PREFIX = "opengeni:realtime-model";
const REALTIME_MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const REALTIME_MODEL_CATALOG_CACHE_MAX_WORKSPACES = 64;

export type RealtimeControllerClient = EmbeddedRealtimeSessionClientLike &
  SessionRealtimeClientLike;

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

function realtimeModelFallback(codexConnected: boolean): RealtimeModelOption[] {
  return [
    {
      ...CODEX_LIVE_MODEL,
      available: codexConnected,
      unavailableReason: codexConnected ? null : CODEX_LIVE_MODEL.unavailableReason,
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

function loadRealtimeModelCatalog(
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

type AdmissionInput = {
  sessionStatus: SessionStatus;
  controlState: "active" | "paused";
  settlement: { state: string } | null;
  codexConnected: boolean;
  lifecycleActive: boolean;
};

export function codexRealtimeAdmissionAllowed(input: AdmissionInput): boolean {
  return codexRealtimeAdmissionBlocker(input) === null;
}

export function codexRealtimeAdmissionBlocker(input: AdmissionInput): string | null {
  if (input.sessionStatus === "cancelled") return "This session was cancelled.";
  if (input.controlState !== "active") return "Resume this session before starting voice.";
  if (input.settlement !== null) return "Wait for the current session transition to finish.";
  if (!input.codexConnected) return "Connect Codex to use this voice model.";
  if (input.lifecycleActive) return "Voice is already active for this session.";
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
  /** Deterministic browser-test/demo seam. Production hosts should use the SDK default. */
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}) {
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const model = options.model ?? CODEX_LIVE_MODEL.id;
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<SessionRealtimeController | null>(null);
  const controllerModelRef = useRef<SessionRealtimeModel | null>(null);
  const modelContextProviderRef = useRef(options.getModelContext);
  modelContextProviderRef.current = options.getModelContext;
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

  useEffect(() => {
    let disposed = false;
    let controller: SessionRealtimeController | null = null;
    let unsubscribe: (() => void) | null = null;
    void import("@opengeni/sdk/realtime")
      .then(({ createSessionRealtimeController }) => {
        if (disposed) return;
        const controllerFactory = options.controllerFactory ?? createSessionRealtimeController;
        controller = controllerFactory({
          client,
          workspaceId,
          sessionId: options.sessionId,
          ...(audioRef.current ? { remoteAudio: audioRef.current } : {}),
          model,
          getModelContext: () => modelContextProviderRef.current?.(),
        });
        controllerRef.current = controller;
        controllerModelRef.current = model;
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
              error instanceof Error ? error.message : "Codex realtime controller failed to load",
            recoverable: false,
            connectionGeneration: 0,
            attempt: 0,
          },
          error:
            error instanceof Error ? error.message : "Codex realtime controller failed to load",
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
  }, [client, model, options.controllerFactory, options.sessionId, workspaceId]);

  useEffect(() => {
    if (!options.eventsReady) return;
    void controllerRef.current?.observeLifecycle(lifecycle).catch(() => undefined);
  }, [lifecycle, options.eventsReady]);

  const start = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || controllerModelRef.current !== model) {
      throw new Error("The selected voice model is still preparing");
    }
    await controller.start();
  }, [model]);
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
      ? (options.modelUnavailableReason ?? "This voice model is unavailable.")
      : codexRealtimeAdmissionBlocker(admissionInput);
  const canStart =
    controllerRef.current !== null &&
    controllerModelRef.current === model &&
    ["idle", "error"].includes(snapshot.status) &&
    admissionBlocker === null;

  return {
    snapshot,
    lifecycleActive,
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
function fallbackRealtimeModelId(models: readonly RealtimeModelOption[]): SessionRealtimeModel {
  return (
    models.find((model) => model.available)?.id ??
    models.find((model) => model.unavailableCode)?.id ??
    CODEX_LIVE_MODEL.id
  );
}

export function useRealtimeModelSelection(options: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  codexConnected: boolean;
  activeModel?: SessionRealtimeModel | null | undefined;
}) {
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const activeModel = options.activeModel;
  const initialCachedCatalog = readCachedRealtimeModelCatalog(client, workspaceId);
  const [catalog, setCatalog] = useState<RealtimeModelOption[]>(
    () => initialCachedCatalog ?? realtimeModelFallback(options.codexConnected),
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
  const [selectedModelId, setSelectedModelId] = useState<SessionRealtimeModel>(() => {
    const preferred = readRealtimeModelPreference(workspaceId) ?? CODEX_LIVE_MODEL.id;
    if (!initialCachedCatalog) return preferred;
    if (initialCachedCatalog.some((model) => model.id === preferred && model.available)) {
      return preferred;
    }
    return fallbackRealtimeModelId(initialCachedCatalog);
  });

  useEffect(() => {
    let disposed = false;
    const requestAbort = new AbortController();
    const applyCatalog = (models: RealtimeModelOption[]) => {
      catalogScopeRef.current = { client, workspaceId, source: "cache" };
      setCatalog(models);
      setSelectedModelId((current) => {
        if (models.some((model) => model.id === current && model.available)) return current;
        return fallbackRealtimeModelId(models);
      });
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
  }, [client, workspaceId]);

  useEffect(() => {
    if (activeModel) setSelectedModelId(activeModel);
  }, [activeModel]);

  const selectedModel =
    catalog.find((model) => model.id === selectedModelId) ??
    ({
      ...CODEX_LIVE_MODEL,
      available: options.codexConnected,
      unavailableReason: options.codexConnected ? null : CODEX_LIVE_MODEL.unavailableReason,
    } satisfies RealtimeModelOption);
  const selectModel = useCallback(
    (value: string) => {
      const model = catalog.find((candidate) => candidate.id === value);
      if (!model || !model.available || activeModel) return;
      setSelectedModelId(model.id);
      writeRealtimeModelPreference(workspaceId, model.id);
    },
    [activeModel, catalog, workspaceId],
  );

  // The fallback catalog is a placeholder: a caller that starts voice on its own
  // (a call from outside the app) waits for the real one, or the selection
  // would change under the starting connection.
  const scope = catalogScopeRef.current;
  const catalogReady =
    (scope.source === "cache" && scope.client === client && scope.workspaceId === workspaceId) ||
    (fallbackFinal?.client === client && fallbackFinal.workspaceId === workspaceId);
  return { models: catalog, selectedModel, selectModel, catalogReady };
}

function toRealtimeModelOption(model: WorkspaceRealtimeModelCatalogItem): RealtimeModelOption {
  return { ...model };
}

function readRealtimeModelPreference(workspaceId: string): SessionRealtimeModel | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(`${REALTIME_MODEL_STORAGE_PREFIX}:${workspaceId}`);
    return isRealtimeModel(value) ? value : null;
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

function isRealtimeModel(value: string | null): value is SessionRealtimeModel {
  return (
    value === "opengeni-azure/gpt-live-1" ||
    value === "gpt-live-1-boulder-alpha" ||
    value === "opengeni-gateway/openai/gpt-realtime-2.1" ||
    value === "opengeni-gateway/openai/gpt-realtime-mini" ||
    value === "opengeni-gateway/xai/grok-voice-think-fast-2.0" ||
    value === "supergrok/grok-voice-think-fast-2.0" ||
    value === "workspace-gateway/openai/gpt-realtime-2.1" ||
    value === "workspace-gateway/openai/gpt-realtime-mini" ||
    value === "workspace-gateway/xai/grok-voice-think-fast-2.0"
  );
}
