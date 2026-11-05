import { codexSubscriptionHeaders, type CodexAuthHeaders } from "./api-client";
import {
  CODEX_REALTIME_CALL_TIMEOUT_MS,
  CODEX_REALTIME_CALLS_URL,
  CODEX_REALTIME_CONFIG_ID,
  CODEX_REALTIME_CONFIG_TIMEOUT_MS,
  CODEX_REALTIME_DEFAULT_VOICE,
  CODEX_REALTIME_MODEL,
  CODEX_REALTIME_PROVIDER_ARCHITECTURE_FALLBACK,
  CODEX_REALTIME_PROVIDER_MODEL_FALLBACK,
  CODEX_REALTIME_VERSION,
  CODEX_WHAM_BASE,
} from "./constants";
import type { CodexFetch } from "./device-code";
import {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
  type CodexRealtimeInitialItem,
} from "./realtime-v3";

const MAX_REALTIME_SDP_BYTES = 1024 * 1024;
const MAX_REALTIME_PROVIDER_VALUE_LENGTH = 128;
const MAX_REALTIME_ERROR_BODY_BYTES = 16 * 1024;
const REALTIME_PROVIDER_VALUE = /^[a-z0-9][a-z0-9._-]*$/i;
/**
 * Short identifier-like provider error fields (`model_not_found`,
 * `invalid_request_error`, `session.model`, `Not Found`). Anything else, such
 * as a sentence that could quote request content, is dropped rather than kept.
 */
const REALTIME_PROVIDER_ERROR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/;
const REALTIME_CALL_ID =
  /^(?:rtc_.+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const CODEX_REALTIME_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export type CodexRealtimeVoice = (typeof CODEX_REALTIME_VOICES)[number];

export type CodexRealtimeCallInput = {
  /** Browser-created WebRTC offer. It must negotiate an audio media section. */
  sdp: string;
  /** This transport intentionally supports only Codex's Frameless/V3 protocol. */
  version: typeof CODEX_REALTIME_VERSION;
  /** Server-owned session/thread binding; sent upstream but never returned. */
  sessionId: string;
  /** Server-projected ordinary-session history for Frameless V3 bootstrap. */
  initialItems?: CodexRealtimeInitialItem[] | undefined;
  instructions?: string | undefined;
  voice?: CodexRealtimeVoice | undefined;
};

export type CodexRealtimeCallResult = {
  sdp: string;
  version: typeof CODEX_REALTIME_VERSION;
  model: typeof CODEX_REALTIME_MODEL;
};

export type CodexRealtimeErrorCode =
  | "invalid_request"
  | "incompatible"
  | "authentication"
  | "entitlement"
  | "rate_limited"
  | "provider"
  | "invalid_response"
  | "network"
  | "timeout"
  | "cancelled";

/**
 * Where a realtime negotiation failed: local validation of the request, the
 * provider's remote configuration read, or the provider's call creation.
 */
export type CodexRealtimeFailureStage = "request" | "config" | "call";

/**
 * Operator diagnostics for one failure. Every value is code-authored or a
 * short provider identifier with a closed grammar; never a response body,
 * credential, account identity, or request content.
 */
export type CodexRealtimeDiagnostics = {
  stage: CodexRealtimeFailureStage;
  /** Provider error `code` (or FastAPI-style `detail`) when identifier-shaped. */
  providerErrorCode?: string | undefined;
  /** Provider error `type` when identifier-shaped. */
  providerErrorType?: string | undefined;
  /** Provider error `param` when identifier-shaped. */
  providerErrorParam?: string | undefined;
  /** Whether call parameters came from the remote configuration or the pinned defaults. */
  configSource?: CodexRealtimeProviderConfig["source"];
  /** Protocol version the remote configuration advertised, when it was readable. */
  advertisedVersion?: string | undefined;
  providerModel?: string | undefined;
  providerArchitecture?: string | undefined;
};

/** Safe provider failure: it contains no response body, credential, or account identity. */
export class CodexRealtimeError extends Error {
  constructor(
    readonly code: CodexRealtimeErrorCode,
    message: string,
    readonly providerStatus: number | null = null,
    readonly diagnostics: CodexRealtimeDiagnostics = { stage: "request" },
  ) {
    super(message);
    this.name = "CodexRealtimeError";
  }
}

export type CodexRealtimeCallOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  providerConfig?: CodexRealtimeProviderConfig | undefined;
};

export type CodexRealtimeProviderConfig = {
  architecture: string;
  model: string;
  version: typeof CODEX_REALTIME_VERSION;
  /**
   * `remote` when the authenticated configuration supplied V3 parameters;
   * `fallback` when the pinned defaults are used instead (configuration
   * unavailable, malformed, or advertising another protocol version).
   */
  source?: "remote" | "fallback" | undefined;
  /** The version the remote configuration advertised, kept for diagnostics. */
  advertisedVersion?: string | undefined;
};

const FALLBACK_REALTIME_PROVIDER_CONFIG: CodexRealtimeProviderConfig = {
  architecture: CODEX_REALTIME_PROVIDER_ARCHITECTURE_FALLBACK,
  model: CODEX_REALTIME_PROVIDER_MODEL_FALLBACK,
  version: CODEX_REALTIME_VERSION,
  source: "fallback",
};

/**
 * Resolve the provider-controlled Codex voice model without changing the
 * stable Opengeni model id. ChatGPT rotates this config independently of Codex
 * releases; pinning the old value caused deterministic call-creation failures.
 *
 * The configuration's `version` is the protocol the first-party desktop client
 * prefers, not a requirement of the call endpoint: the open-source Codex CLI
 * speaks V3 with the pinned defaults and never reads it. So a configuration
 * that advertises another version only means its model and architecture are
 * not V3 values; the call then uses the pinned V3 defaults instead of being
 * refused, and the advertised version is kept for diagnostics.
 */
export async function fetchCodexRealtimeProviderConfig(
  auth: CodexAuthHeaders,
  fetchImpl: CodexFetch = fetch,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<CodexRealtimeProviderConfig> {
  if (options.signal?.aborted) {
    throw new CodexRealtimeError("cancelled", "Codex realtime request cancelled");
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CODEX_REALTIME_CONFIG_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(`${CODEX_WHAM_BASE}/wham/statsig/bootstrap`, {
      method: "POST",
      headers: {
        ...codexSubscriptionHeaders(auth),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        app_session_id: crypto.randomUUID(),
        app_version: auth.clientVersion,
        brand_name: "Codex",
        build_flavor: "stable",
        locale: "en-US",
        stable_id: auth.chatgptAccountId ?? "opengeni-server",
        system_name: "Opengeni",
        system_version: "server",
        window_type: "local",
      }),
      signal: controller.signal,
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexRealtimeError(
        "authentication",
        "Codex subscription rejected authentication",
        response.status,
        { stage: "config" },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return FALLBACK_REALTIME_PROVIDER_CONFIG;
    }
    const outer = (await response.json().catch(() => null)) as {
      statsigPayload?: unknown;
    } | null;
    if (typeof outer?.statsigPayload !== "string") return FALLBACK_REALTIME_PROVIDER_CONFIG;
    const payload = JSON.parse(outer.statsigPayload) as {
      dynamic_configs?: Record<string, { value?: Record<string, unknown> }>;
    };
    const value = payload.dynamic_configs?.[CODEX_REALTIME_CONFIG_ID]?.value;
    const version = value?.version;
    if (version !== undefined && version !== CODEX_REALTIME_VERSION) {
      return {
        ...FALLBACK_REALTIME_PROVIDER_CONFIG,
        ...(validProviderValue(version) ? { advertisedVersion: version } : {}),
      };
    }
    const architecture = validProviderValue(value?.architecture)
      ? value.architecture
      : FALLBACK_REALTIME_PROVIDER_CONFIG.architecture;
    const model = validProviderValue(value?.model)
      ? value.model
      : FALLBACK_REALTIME_PROVIDER_CONFIG.model;
    return {
      architecture,
      model,
      version: CODEX_REALTIME_VERSION,
      source: value ? "remote" : "fallback",
      ...(version === undefined ? {} : { advertisedVersion: CODEX_REALTIME_VERSION }),
    };
  } catch (error) {
    if (error instanceof CodexRealtimeError) throw error;
    if (options.signal?.aborted) {
      throw new CodexRealtimeError("cancelled", "Codex realtime request cancelled", null, {
        stage: "config",
      });
    }
    return FALLBACK_REALTIME_PROVIDER_CONFIG;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Create one native subscription-authenticated Codex GPT-Live V3 WebRTC call.
 *
 * There is deliberately no API-key or WebSocket fallback and no transport
 * retry. A caller may refresh the same connected subscription after one 401,
 * but this adapter always performs exactly one provider request.
 */
export async function createCodexRealtimeCall(
  auth: CodexAuthHeaders,
  input: CodexRealtimeCallInput,
  fetchImpl: CodexFetch = fetch,
  options: CodexRealtimeCallOptions = {},
): Promise<CodexRealtimeCallResult> {
  validateRealtimeInput(input);
  const timeoutMs = options.timeoutMs ?? CODEX_REALTIME_CALL_TIMEOUT_MS;
  const providerConfig = options.providerConfig ?? FALLBACK_REALTIME_PROVIDER_CONFIG;
  const callDiagnostics: CodexRealtimeDiagnostics = {
    stage: "call",
    configSource: providerConfig.source,
    advertisedVersion: validProviderValue(providerConfig.advertisedVersion)
      ? providerConfig.advertisedVersion
      : undefined,
    providerModel: validProviderValue(providerConfig.model) ? providerConfig.model : undefined,
    providerArchitecture: validProviderValue(providerConfig.architecture)
      ? providerConfig.architecture
      : undefined,
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime timeout must be positive");
  }
  if (options.signal?.aborted) {
    throw new CodexRealtimeError("cancelled", "Codex realtime request cancelled");
  }
  if (providerConfig.version !== CODEX_REALTIME_VERSION) {
    throw new CodexRealtimeError(
      "incompatible",
      `Codex realtime provider configuration requires ${providerConfig.version}`,
    );
  }
  if (
    !validProviderValue(providerConfig.architecture) ||
    !validProviderValue(providerConfig.model)
  ) {
    throw new CodexRealtimeError(
      "invalid_request",
      "Codex realtime provider configuration is invalid",
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: ((error: CodexRealtimeError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = (): void => {
    controller.abort(options.signal?.reason);
    rejectCancellation?.(
      new CodexRealtimeError(
        "cancelled",
        "Codex realtime request cancelled",
        null,
        callDiagnostics,
      ),
    );
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new CodexRealtimeError(
          "timeout",
          "Codex realtime request timed out",
          null,
          callDiagnostics,
        ),
      );
    }, timeoutMs);
  });

  const request = (async (): Promise<CodexRealtimeCallResult> => {
    // One fresh voice session per provider call, named in both the header and
    // the session body as the official Codex desktop app does.
    const voiceSessionId = crypto.randomUUID();
    const response = await fetchImpl(
      `${CODEX_REALTIME_CALLS_URL}?intent=quicksilver&architecture=${encodeURIComponent(providerConfig.architecture)}`,
      {
        method: "POST",
        headers: {
          ...codexSubscriptionHeaders(auth),
          "content-type": "application/json",
          "openai-alpha": "quicksilver=v2",
          "session-id": input.sessionId,
          "thread-id": input.sessionId,
          "voice-session-id": voiceSessionId,
        },
        body: JSON.stringify({
          sdp: input.sdp,
          session: {
            instructions: input.instructions ?? "",
            audio: {
              output: { voice: input.voice ?? CODEX_REALTIME_DEFAULT_VOICE },
            },
            delegation: { type: "client" },
            model: providerConfig.model,
            ...(input.initialItems?.length
              ? {
                  initial_items: input.initialItems.map((item) => ({
                    type: "message",
                    role: item.role,
                    content: [
                      {
                        type: item.role === "assistant" ? "output_text" : "input_text",
                        text: item.text,
                      },
                    ],
                  })),
                }
              : {}),
            voice_session_id: voiceSessionId,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const providerError = await readProviderErrorFields(response);
      throw providerHttpError(response.status, { ...callDiagnostics, ...providerError });
    }
    const location = response.headers.get("location");
    if (!location || !validRealtimeLocation(location)) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexRealtimeError(
        "invalid_response",
        "Codex realtime response did not identify a compatible call",
        response.status,
        callDiagnostics,
      );
    }
    const sdp = await readBoundedSdp(response, callDiagnostics);
    if (!isAudioSdp(sdp)) {
      throw new CodexRealtimeError(
        "invalid_response",
        "Codex realtime response was not an audio SDP answer",
        response.status,
        callDiagnostics,
      );
    }
    return {
      sdp,
      version: CODEX_REALTIME_VERSION,
      model: CODEX_REALTIME_MODEL,
    };
  })();

  try {
    // Promise.race attaches rejection handlers to every branch, so a custom
    // fetch that ignores AbortSignal cannot produce a late unhandled rejection.
    return await Promise.race([request, cancellation, deadline]);
  } catch (error) {
    if (error instanceof CodexRealtimeError) throw error;
    if (options.signal?.aborted) {
      throw new CodexRealtimeError(
        "cancelled",
        "Codex realtime request cancelled",
        null,
        callDiagnostics,
      );
    }
    if (timedOut || controller.signal.aborted) {
      throw new CodexRealtimeError(
        "timeout",
        "Codex realtime request timed out",
        null,
        callDiagnostics,
      );
    }
    throw new CodexRealtimeError(
      "network",
      "Codex realtime provider request failed",
      null,
      callDiagnostics,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function validProviderValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_REALTIME_PROVIDER_VALUE_LENGTH &&
    REALTIME_PROVIDER_VALUE.test(value)
  );
}

/** Shared pin→active selection for worker turns and direct realtime calls. */
export function selectCodexCredentialId(args: {
  sessionPinnedCredentialId: string | null;
  activeCredentialId: string | null;
  connectedIds: ReadonlySet<string>;
}): string | null {
  if (args.sessionPinnedCredentialId && args.connectedIds.has(args.sessionPinnedCredentialId)) {
    return args.sessionPinnedCredentialId;
  }
  if (args.activeCredentialId && args.connectedIds.has(args.activeCredentialId)) {
    return args.activeCredentialId;
  }
  return null;
}

function validateRealtimeInput(input: CodexRealtimeCallInput): void {
  if (input.version !== CODEX_REALTIME_VERSION) {
    throw new CodexRealtimeError(
      "incompatible",
      `Codex realtime requires ${CODEX_REALTIME_VERSION}`,
    );
  }
  if (!input.sessionId || input.sessionId.length > 128) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime session id is invalid");
  }
  if (new TextEncoder().encode(input.sdp).byteLength > MAX_REALTIME_SDP_BYTES) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime SDP offer is too large");
  }
  if (!isAudioSdp(input.sdp)) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime requires an audio SDP offer");
  }
  if (input.voice !== undefined && !CODEX_REALTIME_VOICES.includes(input.voice)) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime voice is unsupported");
  }
  const initialItems = input.initialItems ?? [];
  if (initialItems.length > CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT) {
    throw new CodexRealtimeError(
      "invalid_request",
      `Codex realtime history exceeds ${CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT} items`,
    );
  }
  let estimatedTokens = 0;
  for (const item of initialItems) {
    if (
      (item.role !== "user" && item.role !== "developer" && item.role !== "assistant") ||
      typeof item.text !== "string"
    ) {
      throw new CodexRealtimeError("invalid_request", "Codex realtime history item is invalid");
    }
    const itemTokens = Math.ceil(new TextEncoder().encode(item.text).byteLength / 4);
    if (itemTokens > CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS) {
      throw new CodexRealtimeError("invalid_request", "Codex realtime history item is too large");
    }
    estimatedTokens += itemTokens;
  }
  if (estimatedTokens > CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime history is too large");
  }
}

/**
 * Read only the identifier-shaped fields of a bounded JSON error body. The
 * body itself is never kept: free text could quote instructions or history.
 */
async function readProviderErrorFields(
  response: Response,
): Promise<
  Pick<CodexRealtimeDiagnostics, "providerErrorCode" | "providerErrorType" | "providerErrorParam">
> {
  const declared = Number(response.headers.get("content-length"));
  if (!response.body || (Number.isFinite(declared) && declared > MAX_REALTIME_ERROR_BODY_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    return {};
  }
  let text = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REALTIME_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {};
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as { error?: unknown; detail?: unknown };
  const error =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  const code = providerErrorToken(error?.code) ?? providerErrorToken(record.detail);
  const type = providerErrorToken(error?.type);
  const param = providerErrorToken(error?.param);
  return {
    ...(code ? { providerErrorCode: code } : {}),
    ...(type ? { providerErrorType: type } : {}),
    ...(param ? { providerErrorParam: param } : {}),
  };
}

function providerErrorToken(value: unknown): string | null {
  return typeof value === "string" && REALTIME_PROVIDER_ERROR_TOKEN.test(value) ? value : null;
}

function providerHttpError(
  status: number,
  diagnostics: CodexRealtimeDiagnostics,
): CodexRealtimeError {
  if (status === 401) {
    return new CodexRealtimeError(
      "authentication",
      "Codex subscription rejected authentication",
      status,
      diagnostics,
    );
  }
  if (status === 403) {
    return new CodexRealtimeError(
      "entitlement",
      "Codex subscription lacks realtime entitlement",
      status,
      diagnostics,
    );
  }
  if (status === 404) {
    return new CodexRealtimeError(
      "incompatible",
      "Codex subscription realtime is unavailable",
      status,
      diagnostics,
    );
  }
  if (status === 429) {
    return new CodexRealtimeError(
      "rate_limited",
      "Codex realtime is rate limited",
      status,
      diagnostics,
    );
  }
  return new CodexRealtimeError(
    "provider",
    "Codex realtime provider request failed",
    status,
    diagnostics,
  );
}

function validRealtimeLocation(location: string): boolean {
  const path = location.split("?", 1)[0] ?? "";
  const segment = path.split("/").filter(Boolean).at(-1) ?? "";
  return REALTIME_CALL_ID.test(segment);
}

function isAudioSdp(sdp: string): boolean {
  return /^v=0(?:\r?\n)/.test(sdp) && /(?:^|\r?\n)m=audio\s/m.test(sdp);
}

async function readBoundedSdp(
  response: Response,
  diagnostics: CodexRealtimeDiagnostics,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REALTIME_SDP_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CodexRealtimeError(
      "invalid_response",
      "Codex realtime SDP answer is too large",
      response.status,
      diagnostics,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REALTIME_SDP_BYTES) {
        await reader.cancel();
        throw new CodexRealtimeError(
          "invalid_response",
          "Codex realtime SDP answer is too large",
          response.status,
          diagnostics,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodexRealtimeError(
      "invalid_response",
      "Codex realtime SDP answer was not valid UTF-8",
      response.status,
      diagnostics,
    );
  }
}
