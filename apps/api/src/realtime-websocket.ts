import {
  resolveElevenLabsRealtimeLanguage,
  resolveElevenLabsRealtimeModel,
  SUPERGROK_REALTIME_MODEL_ID,
  VERCEL_AI_GATEWAY_AI_SDK_BASE_URL,
  VERCEL_AI_GATEWAY_BASE_URL,
  resolveAiGatewayRealtimeModel,
  type Settings,
} from "@opengeni/config";
import type {
  RealtimeWebsocketProtocol,
  SessionRealtimeModel,
  SessionRealtimeWebsocketInitialItem,
} from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
  getSessionRealtimeContinuityEntries,
  loadWorkspaceProviderApiKey,
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
 */
export type RealtimeWebsocketProviderId = "ai-gateway" | "supergrok" | "elevenlabs";

export type RealtimeWebsocketBrokerErrorCode =
  | "model_unavailable"
  | "credential_unavailable"
  | "provider_error"
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
  /** BCP 47 tag of the language the person speaks, when the client sent one. */
  language: string | undefined;
  fetchImpl: typeof fetch;
};

type MintedConnection = Omit<RealtimeWebsocketConnection, "instructions" | "initialItems">;

type RealtimeWebsocketProvider = {
  id: RealtimeWebsocketProviderId;
  /** Prefix of the public error code, for example `GATEWAY_REALTIME_CREDENTIAL_UNAVAILABLE`. */
  errorCodePrefix: string;
  matches(model: SessionRealtimeModel): boolean;
  /**
   * Mint the provider connection. `loadHistory` runs the session history reads;
   * a provider that must hold a lease while minting runs them inside it.
   */
  connect<T>(
    input: ProviderInput,
    loadHistory: () => Promise<T>,
  ): Promise<{ minted: MintedConnection; history: T }>;
};

const AUDIO_SAMPLE_RATE = 24_000;
const CLIENT_SECRET_TTL_SECONDS = 120;

/** The one tool every realtime voice model uses to hand work to the session agent. */
export function realtimeDelegationTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "delegate_to_session",
    description:
      "Pass execution work, actions, and session tasks to the underlying session agent. Include the complete standalone request and relevant conversational context.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "Complete standalone task for the session agent",
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
    const [history, secret] = await Promise.all([
      loadHistory(),
      mintAiGatewayClientSecret({
        apiKey,
        source: resolved.source,
        upstreamModelId: resolved.upstreamModelId,
        fetchImpl: input.fetchImpl,
      }),
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
            voice: "eve",
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

/**
 * Eleven Realtime with the workspace's own ElevenLabs key. The client-secret
 * request carries the whole session, so the browser sends no session update.
 * ElevenLabs accepts only semantic turn detection; `high` eagerness answers as
 * soon as the speaker is done.
 * ElevenLabs does not detect the spoken language, so the conversation language
 * comes from the person's language; it sets what the model hears and the
 * language it replies in. An unsupported language keeps the provider default.
 */
const elevenLabsProvider: RealtimeWebsocketProvider = {
  id: "elevenlabs",
  errorCodePrefix: "ELEVENLABS_REALTIME",
  matches: (model) => resolveElevenLabsRealtimeModel(model) !== null,
  async connect(input, loadHistory) {
    const upstreamModelId = resolveElevenLabsRealtimeModel(input.model);
    if (!upstreamModelId) {
      throw new RealtimeWebsocketBrokerError(
        "model_unavailable",
        "The selected model is not an Eleven Realtime model",
      );
    }
    const apiKey = await loadWorkspaceProviderApiKey(
      input.db,
      input.settings,
      input.workspaceId,
      "elevenlabs",
    );
    if (!apiKey) {
      throw new RealtimeWebsocketBrokerError(
        "credential_unavailable",
        "Connect an ElevenLabs API key to use this voice model",
      );
    }
    const language =
      input.language === undefined ? null : resolveElevenLabsRealtimeLanguage(input.language);
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
              transcription: language === null ? {} : { language },
              turn_detection: { type: "semantic_vad", eagerness: "high" },
            },
            output: { format: { type: "audio/pcm" } },
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
    await response.body?.cancel().catch(() => undefined);
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
  const { minted, history } = await provider.connect(
    {
      db: input.db,
      settings: input.settings,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      model: input.model,
      instructions,
      language: input.language,
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
