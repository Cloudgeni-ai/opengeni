import {
  ELEVENLABS_REALTIME_LANGUAGES,
  resolveElevenLabsRealtimeLanguage,
  resolveElevenLabsRealtimeModel,
  SUPERGROK_REALTIME_MODEL_ID,
  VERCEL_AI_GATEWAY_AI_SDK_BASE_URL,
  VERCEL_AI_GATEWAY_BASE_URL,
  resolveAiGatewayRealtimeModel,
  type Settings,
} from "@opengeni/config";
import type {
  RealtimeTurnEagerness,
  RealtimeVoiceSettings,
  RealtimeWebsocketProtocol,
  SessionRealtimeModel,
  SessionRealtimeWebsocketInitialItem,
  WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/contracts";
import { resolveRealtimeVoiceSettings } from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
  getOrganizationModelDefaults,
  getSessionRealtimeContinuityEntries,
  getWorkspaceProviderApiKeyConnectionMetadata,
  getWorkspaceSettings,
  loadOrganizationModelProviderApiKey,
  loadWorkspaceProviderApiKey,
  organizationModelProviderConnectionActiveForWorkspace,
  loadWorkspaceVercelAiGatewayApiKey,
  readSubscriptionCoreProviderRouteForWorkspace,
  readSubscriptionCoreSessionOwner,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  subscriptionCoreXaiRequestAuth,
  type Database,
  type SubscriptionCoreFetch,
} from "@opengeni/db";
import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_PUBLIC_API_BASE_URL,
  type XaiProxyAuthContext,
} from "@opengeni/xai-subscription";

import { openGeniRealtimeInstructions } from "./codex-realtime";
import { projectSessionRealtimeInitialItems } from "./session-realtime-context";

/**
 * Realtime voice providers reached by the browser over a WebSocket.
 *
 * Every provider here mints a short-lived client secret with the workspace or
 * subscription credential and returns everything the browser needs to open
 * the provider socket: the URL, the WebSocket subprotocols that carry the
 * secret, the wire protocol, and the first session event to send. The browser
 * runs one transport for all of them; adding an OpenAI-compatible provider is
 * one entry in `REALTIME_WEBSOCKET_PROVIDERS`.
 *
 * Each provider also declares the voice settings it offers (`voiceOptions`).
 * The shared path resolves the workspace's saved settings and the connection's
 * own settings against those options, so a provider only maps the resolved
 * values onto its session.
 */
export type RealtimeWebsocketProviderId = "ai-gateway" | "supergrok" | "elevenlabs";

export type RealtimeWebsocketBrokerErrorCode =
  | "model_unavailable"
  | "credential_unavailable"
  | "provider_error"
  | "voice_unavailable"
  | "invalid_provider_response";

export class RealtimeWebsocketBrokerError extends Error {
  constructor(
    readonly code: RealtimeWebsocketBrokerErrorCode,
    message: string,
    readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "RealtimeWebsocketBrokerError";
  }
}

export type RealtimeWebsocketConnection = {
  provider: RealtimeWebsocketProviderId;
  protocol: RealtimeWebsocketProtocol;
  url: string;
  /** WebSocket subprotocols, including the one that carries the client secret. */
  protocols: string[];
  token: string;
  upstreamModelId: string;
  expiresAt: number | null;
  /** First client event after the socket opens, or null when the mint already configured it. */
  sessionUpdate: Record<string, unknown> | null;
  /** Assistant transcripts carry inline delivery tags such as `[calm]`. */
  transcriptAudioTags?: boolean;
  instructions: string;
  initialItems: SessionRealtimeWebsocketInitialItem[];
};

type ProviderInput = {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  model: SessionRealtimeModel;
  instructions: string;
  fetchImpl: typeof fetch;
};

type MintedConnection = Omit<RealtimeWebsocketConnection, "instructions" | "initialItems">;

/** Voice settings a model offers, as listed on its catalog entry. */
export type RealtimeVoiceOptions = Pick<
  WorkspaceRealtimeModelCatalogItem,
  "languages" | "voices" | "customVoice" | "turnEagerness" | "voiceDefaults"
>;

/** Voice settings resolved for one connection; unset fields keep the provider default. */
export type ResolvedRealtimeVoice = {
  voice?: string;
  /** The provider's language code. */
  language?: string;
  turnEagerness?: RealtimeTurnEagerness;
};

type RealtimeWebsocketProvider = {
  id: RealtimeWebsocketProviderId;
  /** Prefix of the public error code, for example `GATEWAY_REALTIME_CREDENTIAL_UNAVAILABLE`. */
  errorCodePrefix: string;
  matches(model: SessionRealtimeModel): boolean;
  /** The voice settings this provider offers for `model`; empty when none can be chosen. */
  voiceOptions(model: SessionRealtimeModel): RealtimeVoiceOptions;
  /** The provider language code for a BCP 47 tag; required when `languages` is offered. */
  resolveLanguage?(tag: string): string | null;
  /**
   * Mint the provider connection. `loadHistory` runs the session history reads;
   * a provider that must hold a lease while minting runs them inside it.
   * `input.voice` settles with the resolved voice settings.
   */
  connect<T>(
    input: ProviderInput & { voice: Promise<ResolvedRealtimeVoice> },
    loadHistory: () => Promise<T>,
  ): Promise<{ minted: MintedConnection; history: T }>;
};

const AUDIO_SAMPLE_RATE = 24_000;
const CLIENT_SECRET_TTL_SECONDS = 120;

const voiceChoices = (ids: readonly string[]) =>
  ids.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }));

// Built-in voices of each upstream model family.
const OPENAI_REALTIME_VOICES = voiceChoices([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
]);
const XAI_REALTIME_VOICES = voiceChoices(["eve", "ara", "rex", "sal", "leo"]);

/** The one tool every realtime voice model uses to hand work to the session agent. */
export function realtimeDelegationTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "delegate_to_session",
    description:
      "Relay execution work, actions, and session tasks to the underlying session agent, which decides how to do them.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "The user's request in their own words and language, plus only the conversational context needed to understand it. Do not add tools, methods, steps, or details the user did not say.",
        },
      },
      required: ["request"],
      additionalProperties: false,
    },
  };
}

const aiGatewayProvider: RealtimeWebsocketProvider = {
  id: "ai-gateway",
  errorCodePrefix: "GATEWAY_REALTIME",
  matches: (model) => resolveAiGatewayRealtimeModel(model) !== null,
  // The Gateway maps the session voice to the upstream model's own voices; the
  // upstream model keeps its default voice until one is chosen.
  voiceOptions(model) {
    const upstream = resolveAiGatewayRealtimeModel(model)?.upstreamModelId ?? "";
    if (upstream.startsWith("openai/")) return { voices: OPENAI_REALTIME_VOICES };
    if (upstream.startsWith("xai/")) return { voices: XAI_REALTIME_VOICES };
    return {};
  },
  async connect(input, loadHistory) {
    const resolved = resolveAiGatewayRealtimeModel(input.model);
    if (!resolved) {
      throw new RealtimeWebsocketBrokerError(
        "model_unavailable",
        "The selected model is not an AI Gateway realtime model",
      );
    }
    const apiKey =
      resolved.source === "managed"
        ? input.settings.vercelAiGatewayApiKey
        : await loadWorkspaceVercelAiGatewayApiKey(input.db, input.settings, input.workspaceId);
    if (!apiKey) {
      throw new RealtimeWebsocketBrokerError(
        "credential_unavailable",
        resolved.source === "managed"
          ? "Managed voice is not configured"
          : "The workspace AI Gateway connection is unavailable",
      );
    }
    const [history, secret, voice] = await Promise.all([
      loadHistory(),
      mintAiGatewayClientSecret({
        apiKey,
        source: resolved.source,
        upstreamModelId: resolved.upstreamModelId,
        fetchImpl: input.fetchImpl,
      }),
      input.voice,
    ]);
    const url = new URL(
      `${VERCEL_AI_GATEWAY_AI_SDK_BASE_URL.replace(/^http/, "ws")}/realtime-model`,
    );
    url.searchParams.set("ai-model-id", resolved.upstreamModelId);
    return {
      history,
      minted: {
        provider: "ai-gateway",
        protocol: "ai-gateway",
        url: url.toString(),
        protocols: ["ai-gateway-realtime.v1", `ai-gateway-auth.${secret.token}`],
        token: secret.token,
        upstreamModelId: resolved.upstreamModelId,
        expiresAt: secret.expiresAt,
        sessionUpdate: {
          type: "session-update",
          config: {
            instructions: input.instructions,
            ...(voice.voice ? { voice: voice.voice } : {}),
            outputModalities: ["audio"],
            inputAudioFormat: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
            outputAudioFormat: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            turnDetection: {
              type: "server-vad",
              prefixPaddingMs: 300,
              silenceDurationMs: 500,
            },
            tools: [realtimeDelegationTool()],
          },
        },
      },
    };
  },
};

async function mintAiGatewayClientSecret(input: {
  apiKey: string;
  source: "managed" | "workspace";
  upstreamModelId: string;
  fetchImpl: typeof fetch;
}): Promise<{ token: string; expiresAt: number | null }> {
  const mintUrl = new URL("/v1/realtime/client-secrets", VERCEL_AI_GATEWAY_BASE_URL);
  let response: Response;
  try {
    response = await input.fetchImpl(mintUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "ai-gateway-auth-method": "api-key",
        "ai-gateway-protocol-version": "0.0.1",
      },
      body: JSON.stringify({ model: input.upstreamModelId, expiresIn: CLIENT_SECRET_TTL_SECONDS }),
    });
  } catch {
    throw new RealtimeWebsocketBrokerError(
      "provider_error",
      "The voice provider could not be reached. Try again.",
    );
  }
  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    // User-facing: say what to do, never which deployment credential failed.
    throw new RealtimeWebsocketBrokerError(
      rejected ? "credential_unavailable" : "provider_error",
      rejected
        ? input.source === "managed"
          ? "Voice is temporarily unavailable. Try another voice model."
          : "Your AI Gateway key was rejected. Update it in workspace settings."
        : "The voice provider could not start a call. Try again.",
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.token;
  const expiresAt = body?.expiresAt;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== "number")
  ) {
    throw new RealtimeWebsocketBrokerError(
      "invalid_provider_response",
      "AI Gateway returned an invalid realtime token",
      response.status,
    );
  }
  return { token, expiresAt: typeof expiresAt === "number" ? expiresAt : null };
}

const SUPERGROK_UPSTREAM_MODEL_ID = "grok-voice-think-fast-2.0";

/**
 * SuperGrok realtime on the shared subscription core (the M3 Codex rule,
 * EP-N05/N07/S17): the session's recorded owner (never the caller), shared
 * organization- or workspace-scoped connections only (decision 3), a
 * `realtime` operation lease held through the client-secret request, with
 * refresh under the per-connection lock. The session binding is never read
 * for placement beyond an explicit choice and never written (decision 6).
 */
const supergrokProvider: RealtimeWebsocketProvider = {
  id: "supergrok",
  errorCodePrefix: "SUPERGROK_REALTIME",
  matches: (model) => model === SUPERGROK_REALTIME_MODEL_ID,
  voiceOptions: () => ({ voices: XAI_REALTIME_VOICES, voiceDefaults: { voice: "eve" } }),
  async connect(input, loadHistory) {
    const unavailable = () =>
      new RealtimeWebsocketBrokerError(
        "credential_unavailable",
        "No eligible connected SuperGrok account is available",
      );
    const route = await readSubscriptionCoreProviderRouteForWorkspace(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
    });
    // SuperGrok realtime runs only on the shared core; any other route
    // (maintenance, or no receipt) has no eligible account.
    if (route !== "core") throw unavailable();
    // The deployment switch for SuperGrok subscriptions, as the Codex broker checks its own.
    if (!input.settings.supergrokSubscriptionEnabled) throw unavailable();
    const context = {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    };
    const owner = await readSubscriptionCoreSessionOwner(input.db, context);
    if (!owner) throw unavailable();
    const scope = {
      kind: "session" as const,
      ...context,
      sessionOwnerSubjectId: owner.ownerSubjectId,
    };
    const connections = subscriptionCoreOperationConnections(SUBSCRIPTION_CORE_XAI);
    const candidates = await connections.listSubscriptionCoreOperationCandidates(input.db, scope);
    const ran = await connections.runSubscriptionCoreOperation(
      input.db,
      input.settings,
      scope,
      {
        candidates: candidates.map((candidate) => candidate.connectionId),
        operationKind: "realtime",
        holderId: `realtime:${input.sessionId}`,
        fetchImpl: input.fetchImpl,
      },
      async ({ resolver, fetch: requestFetch, fence }) =>
        await Promise.all([
          loadHistory(),
          mintXaiClientSecret({
            context: subscriptionCoreXaiRequestAuth(resolver),
            fetchImpl: async (url, init) => {
              // Pre-dispatch fence on the exact operation lease.
              if (!(await fence())) throw unavailable();
              return await requestFetch(url, init);
            },
          }),
        ]),
    );
    if (ran.kind === "unavailable") throw unavailable();
    const [history, secret] = ran.value;
    const voice = await input.voice;
    const url = new URL("wss://api.x.ai/v1/realtime");
    url.searchParams.set("model", SUPERGROK_UPSTREAM_MODEL_ID);
    return {
      history,
      minted: {
        provider: "supergrok",
        protocol: "openai",
        url: url.toString(),
        protocols: [`xai-client-secret.${secret.token}`],
        token: secret.token,
        upstreamModelId: SUPERGROK_UPSTREAM_MODEL_ID,
        expiresAt: secret.expiresAt,
        sessionUpdate: {
          type: "session.update",
          session: {
            instructions: input.instructions,
            voice: voice.voice ?? "eve",
            reasoning: { effort: "high" },
            turn_detection: {
              type: "server_vad",
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            audio: {
              input: {
                format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
                transcription: { model: "grok-transcribe" },
              },
              output: { format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE } },
            },
            tools: [realtimeDelegationTool()],
          },
        },
      },
    };
  },
};

async function mintXaiClientSecret(input: {
  context: Pick<XaiProxyAuthContext, "getToken" | "refresh">;
  fetchImpl: SubscriptionCoreFetch;
}): Promise<{ token: string; expiresAt: number | null }> {
  const request = async (accessToken: string) =>
    await input.fetchImpl(`${XAI_PUBLIC_API_BASE_URL}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": `opengeni/${XAI_CLIENT_VERSION}`,
        "x-grok-client-version": XAI_CLIENT_VERSION,
        "x-grok-client-identifier": "opengeni",
        "x-grok-client-mode": XAI_CLIENT_MODE,
      },
      body: JSON.stringify({ expires_after: { seconds: CLIENT_SECRET_TTL_SECONDS } }),
    });
  let response: Response;
  try {
    let token = await input.context.getToken();
    response = await request(token.accessToken);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      token = await input.context.refresh();
      response = await request(token.accessToken);
    }
  } catch (error) {
    // A core pre-dispatch fence refusal is already typed.
    if (error instanceof RealtimeWebsocketBrokerError) throw error;
    throw new RealtimeWebsocketBrokerError("provider_error", "xAI realtime token request failed");
  }
  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    throw new RealtimeWebsocketBrokerError(
      rejected ? "credential_unavailable" : "provider_error",
      rejected ? "SuperGrok credentials were rejected" : "xAI realtime token request failed",
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.value;
  if (typeof token !== "string" || token.length === 0) {
    throw new RealtimeWebsocketBrokerError(
      "invalid_provider_response",
      "xAI returned an invalid realtime token",
      response.status,
    );
  }
  return { token, expiresAt: normalizeExpiry(body?.expires_at ?? body?.expiresAt) };
}

function normalizeExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io";
// ElevenLabs closes a session after 600 seconds unless asked for longer. Opengeni
// rotates provider connections well before an hour, so the session never ends early.
const ELEVENLABS_MAX_SESSION_SECONDS = 3_600;
const ELEVENLABS_DEFAULT_VOICE = "brian";
// ElevenLabs' built-in realtime voices; any voice id in the account's own voices also works.
const ELEVENLABS_REALTIME_VOICES = voiceChoices([
  "brian",
  "chris",
  "george",
  "jessica",
  "liam",
  "lily",
  "matilda",
  "michael",
  "sarah",
  "will",
]);

/**
 * Eleven Realtime with the workspace's own ElevenLabs key. The client-secret
 * request carries the whole session, so the browser sends no session update.
 * ElevenLabs accepts only semantic turn detection; the default `high`
 * eagerness answers as soon as the speaker is done. Besides the built-in
 * voices, any voice in the account's own voices (My Voices) can be chosen by
 * its voice id; a library voice must be added there first.
 * ElevenLabs does not detect the spoken language, so the conversation language
 * comes from the person's language; it sets what the model hears and the
 * language it replies in. An unsupported language keeps the provider default.
 */
/**
 * The ElevenLabs key a workspace's voice sessions use: the workspace's own
 * key when it has one, else its organization's key.
 */
async function loadElevenLabsApiKey(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string },
): Promise<string | null> {
  return (
    (await loadWorkspaceProviderApiKey(db, settings, scope.workspaceId, "elevenlabs")) ??
    (await loadOrganizationModelProviderApiKey(db, settings, {
      ...scope,
      providerKind: "elevenlabs",
    }))
  );
}

/** Whether a workspace has an ElevenLabs key to use, its own or its organization's. */
export async function elevenLabsKeyAvailable(
  db: Database,
  scope: { accountId: string; workspaceId: string },
): Promise<boolean> {
  const [own, organization] = await Promise.all([
    getWorkspaceProviderApiKeyConnectionMetadata(db, scope.workspaceId, "elevenlabs"),
    organizationModelProviderConnectionActiveForWorkspace(db, {
      ...scope,
      providerKind: "elevenlabs",
    }),
  ]);
  return own !== null || organization;
}

const elevenLabsProvider: RealtimeWebsocketProvider = {
  id: "elevenlabs",
  errorCodePrefix: "ELEVENLABS_REALTIME",
  matches: (model) => resolveElevenLabsRealtimeModel(model) !== null,
  voiceOptions: () => ({
    languages: [...ELEVENLABS_REALTIME_LANGUAGES],
    voices: ELEVENLABS_REALTIME_VOICES,
    customVoice: true,
    turnEagerness: ["low", "medium", "high"],
    voiceDefaults: { voice: ELEVENLABS_DEFAULT_VOICE, turnEagerness: "high" },
  }),
  resolveLanguage: resolveElevenLabsRealtimeLanguage,
  async connect(input, loadHistory) {
    const upstreamModelId = resolveElevenLabsRealtimeModel(input.model);
    if (!upstreamModelId) {
      throw new RealtimeWebsocketBrokerError(
        "model_unavailable",
        "The selected model is not an Eleven Realtime model",
      );
    }
    const [apiKey, voice] = await Promise.all([
      loadElevenLabsApiKey(input.db, input.settings, input),
      input.voice,
    ]);
    if (!apiKey) {
      throw new RealtimeWebsocketBrokerError(
        "credential_unavailable",
        "Connect an ElevenLabs API key to use this voice model",
      );
    }
    const [history, secret] = await Promise.all([
      loadHistory(),
      mintElevenLabsClientSecret({
        apiKey,
        fetchImpl: input.fetchImpl,
        session: {
          type: "realtime",
          model: upstreamModelId,
          instructions: input.instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
              transcription: voice.language === undefined ? {} : { language: voice.language },
              turn_detection: { type: "semantic_vad", eagerness: voice.turnEagerness ?? "high" },
            },
            output: {
              format: { type: "audio/pcm" },
              ...(voice.voice ? { voice: voice.voice } : {}),
            },
          },
          tools: [realtimeDelegationTool()],
          max_duration_seconds: ELEVENLABS_MAX_SESSION_SECONDS,
        },
      }),
    ]);
    const url = new URL("wss://api.elevenlabs.io/v1/convai/realtime");
    url.searchParams.set("model", upstreamModelId);
    return {
      history,
      minted: {
        provider: "elevenlabs",
        protocol: "openai",
        url: url.toString(),
        protocols: ["realtime", `openai-insecure-api-key.${secret.token}`],
        token: secret.token,
        upstreamModelId,
        expiresAt: secret.expiresAt,
        sessionUpdate: null,
        transcriptAudioTags: true,
      },
    };
  },
};

async function mintElevenLabsClientSecret(input: {
  apiKey: string;
  session: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<{ token: string; expiresAt: number | null }> {
  let response: Response;
  try {
    response = await input.fetchImpl(
      `${ELEVENLABS_API_BASE_URL}/v1/convai/realtime/client_secrets`,
      {
        method: "POST",
        headers: { "xi-api-key": input.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          session: input.session,
          expires_after: { seconds: CLIENT_SECRET_TTL_SECONDS },
        }),
      },
    );
  } catch {
    throw new RealtimeWebsocketBrokerError(
      "provider_error",
      "ElevenLabs could not be reached. Try again.",
    );
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as {
      detail?: { code?: unknown };
    } | null;
    if (failure?.detail?.code === "invalid_voice_id") {
      throw new RealtimeWebsocketBrokerError(
        "voice_unavailable",
        "ElevenLabs doesn't recognize the chosen voice. Add it to My Voices in ElevenLabs, or choose another voice in the workspace's voice settings.",
        response.status,
      );
    }
    const rejected = response.status === 401 || response.status === 403;
    throw new RealtimeWebsocketBrokerError(
      rejected ? "credential_unavailable" : "provider_error",
      rejected
        ? "ElevenLabs rejected the workspace API key. Replace it in the workspace's models settings."
        : "ElevenLabs could not start the voice session. Try again.",
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.value;
  if (typeof token !== "string" || token.length === 0) {
    throw new RealtimeWebsocketBrokerError(
      "invalid_provider_response",
      "ElevenLabs returned an invalid realtime token",
      response.status,
    );
  }
  return { token, expiresAt: normalizeExpiry(body?.expires_at) };
}

const REALTIME_WEBSOCKET_PROVIDERS: readonly RealtimeWebsocketProvider[] = [
  aiGatewayProvider,
  supergrokProvider,
  elevenLabsProvider,
];

/** The WebSocket provider for a realtime model, or null when the model uses WebRTC. */
export function realtimeWebsocketProvider(
  model: SessionRealtimeModel,
): Pick<RealtimeWebsocketProvider, "id" | "errorCodePrefix"> | null {
  return REALTIME_WEBSOCKET_PROVIDERS.find((provider) => provider.matches(model)) ?? null;
}

/** The voice settings a realtime model offers; empty for models whose voice cannot be configured. */
export function realtimeVoiceOptions(model: SessionRealtimeModel): RealtimeVoiceOptions {
  return (
    REALTIME_WEBSOCKET_PROVIDERS.find((provider) => provider.matches(model))?.voiceOptions(model) ??
    {}
  );
}

/**
 * Resolve one connection's voice settings against what the provider offers.
 * Each field comes from the connection's own settings, else the workspace's
 * saved settings for the model, else the provider default. The language falls
 * back further to the person's language. A value the provider does not offer
 * is skipped, never sent.
 */
export function resolveRealtimeVoice(input: {
  provider: Pick<RealtimeWebsocketProvider, "voiceOptions" | "resolveLanguage">;
  model: SessionRealtimeModel;
  connection: RealtimeVoiceSettings | undefined;
  workspace: RealtimeVoiceSettings | null;
  personLanguage: string | undefined;
}): ResolvedRealtimeVoice {
  const options = input.provider.voiceOptions(input.model);
  const layers = [input.connection, input.workspace ?? undefined];
  const pick = <K extends keyof RealtimeVoiceSettings>(
    key: K,
    offered: (value: NonNullable<RealtimeVoiceSettings[K]>) => boolean,
  ) =>
    layers
      .map((layer) => layer?.[key])
      .find((value): value is NonNullable<RealtimeVoiceSettings[K]> =>
        value === undefined ? false : offered(value as NonNullable<RealtimeVoiceSettings[K]>),
      );
  const voice = pick(
    "voice",
    (value) => options.customVoice === true || (options.voices ?? []).some((v) => v.id === value),
  );
  const turnEagerness = pick("turnEagerness", (value) =>
    (options.turnEagerness ?? []).includes(value),
  );
  const resolveLanguage = input.provider.resolveLanguage;
  const language =
    options.languages && resolveLanguage
      ? [...layers.map((layer) => layer?.language), input.personLanguage]
          .map((tag) => (tag === undefined ? null : resolveLanguage(tag)))
          .find((code): code is string => code !== null)
      : undefined;
  return {
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(turnEagerness !== undefined ? { turnEagerness } : {}),
  };
}

/** Mint one provider connection with the session's history and Opengeni instructions. */
export async function createRealtimeWebsocketConnection(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  model: SessionRealtimeModel;
  /** BCP 47 tag of the language the person speaks. */
  language?: string | undefined;
  /** This connection's own voice settings, over the workspace's saved ones. */
  voiceSettings?: RealtimeVoiceSettings | undefined;
  /** Test seams for provider requests, by provider. */
  fetchImpls?: Partial<Record<RealtimeWebsocketProviderId, typeof fetch | undefined>>;
}): Promise<RealtimeWebsocketConnection> {
  const provider = REALTIME_WEBSOCKET_PROVIDERS.find((candidate) => candidate.matches(input.model));
  if (!provider) {
    throw new RealtimeWebsocketBrokerError(
      "model_unavailable",
      "The selected model does not use a WebSocket realtime connection",
    );
  }
  const instructions = openGeniRealtimeInstructions();
  // Read alongside the provider's credential, not before it.
  const voice = Promise.all([
    getWorkspaceSettings(input.db, input.workspaceId),
    getOrganizationModelDefaults(input.db, input.accountId),
  ]).then(([settings, organizationDefaults]) =>
    resolveRealtimeVoice({
      provider,
      model: input.model,
      connection: input.voiceSettings,
      workspace: resolveRealtimeVoiceSettings(settings, organizationDefaults, input.model),
      personLanguage: input.language,
    }),
  );
  // A provider that fails before reading it must not leave it unhandled.
  voice.catch(() => undefined);
  const { minted, history } = await provider.connect(
    {
      db: input.db,
      settings: input.settings,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      model: input.model,
      instructions,
      voice,
      fetchImpl: input.fetchImpls?.[provider.id] ?? fetch,
    },
    async () =>
      await Promise.all([
        getActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
        getSessionRealtimeContinuityEntries(input.db, input.workspaceId, input.sessionId),
      ]),
  );
  return {
    ...minted,
    instructions,
    initialItems: projectSessionRealtimeInitialItems(history[0], history[1]),
  };
}
