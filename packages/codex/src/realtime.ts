import { codexSubscriptionHeaders, type CodexAuthHeaders } from "./api-client";
import {
  CODEX_REALTIME_CALL_TIMEOUT_MS,
  CODEX_REALTIME_DEFAULT_VOICE,
  CODEX_REALTIME_MODEL,
  CODEX_REALTIME_VERSION,
  CODEX_RESPONSES_BASE,
} from "./constants";
import type { CodexFetch } from "./device-code";
import {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
  type CodexRealtimeInitialItem,
} from "./realtime-v3";

const CODEX_REALTIME_CALL_URL = `${CODEX_RESPONSES_BASE}/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_REALTIME_SDP_BYTES = 1024 * 1024;
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

/** Safe provider failure: it contains no response body, credential, or account identity. */
export class CodexRealtimeError extends Error {
  constructor(
    readonly code: CodexRealtimeErrorCode,
    message: string,
    readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "CodexRealtimeError";
  }
}

export type CodexRealtimeCallOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexRealtimeError("invalid_request", "Codex realtime timeout must be positive");
  }
  if (options.signal?.aborted) {
    throw new CodexRealtimeError("cancelled", "Codex realtime request cancelled");
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
    rejectCancellation?.(new CodexRealtimeError("cancelled", "Codex realtime request cancelled"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new CodexRealtimeError("timeout", "Codex realtime request timed out"));
    }, timeoutMs);
  });

  const request = (async (): Promise<CodexRealtimeCallResult> => {
    const response = await fetchImpl(CODEX_REALTIME_CALL_URL, {
      method: "POST",
      headers: {
        ...codexSubscriptionHeaders(auth),
        "content-type": "application/json",
        "openai-alpha": "quicksilver=v2",
        "session-id": input.sessionId,
        "thread-id": input.sessionId,
      },
      body: JSON.stringify({
        sdp: input.sdp,
        session: {
          instructions: input.instructions ?? "",
          audio: {
            output: { voice: input.voice ?? CODEX_REALTIME_DEFAULT_VOICE },
          },
          delegation: { type: "client" },
          model: CODEX_REALTIME_MODEL,
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
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw providerHttpError(response.status);
    }
    const location = response.headers.get("location");
    if (!location || !validRealtimeLocation(location)) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexRealtimeError(
        "invalid_response",
        "Codex realtime response did not identify a compatible call",
        response.status,
      );
    }
    const sdp = await readBoundedSdp(response);
    if (!isAudioSdp(sdp)) {
      throw new CodexRealtimeError(
        "invalid_response",
        "Codex realtime response was not an audio SDP answer",
        response.status,
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
      throw new CodexRealtimeError("cancelled", "Codex realtime request cancelled");
    }
    if (timedOut || controller.signal.aborted) {
      throw new CodexRealtimeError("timeout", "Codex realtime request timed out");
    }
    throw new CodexRealtimeError("network", "Codex realtime provider request failed");
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
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

function providerHttpError(status: number): CodexRealtimeError {
  if (status === 401) {
    return new CodexRealtimeError(
      "authentication",
      "Codex subscription rejected authentication",
      status,
    );
  }
  if (status === 403) {
    return new CodexRealtimeError(
      "entitlement",
      "Codex subscription lacks realtime entitlement",
      status,
    );
  }
  if (status === 404) {
    return new CodexRealtimeError(
      "incompatible",
      "Codex subscription realtime is unavailable",
      status,
    );
  }
  if (status === 429) {
    return new CodexRealtimeError("rate_limited", "Codex realtime is rate limited", status);
  }
  return new CodexRealtimeError("provider", "Codex realtime provider request failed", status);
}

function validRealtimeLocation(location: string): boolean {
  const path = location.split("?", 1)[0] ?? "";
  const segment = path.split("/").filter(Boolean).at(-1) ?? "";
  return REALTIME_CALL_ID.test(segment);
}

function isAudioSdp(sdp: string): boolean {
  return /^v=0(?:\r?\n)/.test(sdp) && /(?:^|\r?\n)m=audio\s/m.test(sdp);
}

async function readBoundedSdp(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REALTIME_SDP_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CodexRealtimeError(
      "invalid_response",
      "Codex realtime SDP answer is too large",
      response.status,
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
    );
  }
}
