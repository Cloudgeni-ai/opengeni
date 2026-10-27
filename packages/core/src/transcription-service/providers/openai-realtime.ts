import {
  RecordingTranscriptionError,
  type RecordingLiveSessionGrant,
  type RecordingLiveSessionRequest,
} from "../../recording-transcription";

/**
 * The live transcript on OpenAI's Realtime API, which OpenAI and Azure OpenAI
 * both serve. The server mints a short-lived client secret for a session that
 * is already set up as a transcription session; the client connects with it,
 * over WebRTC in a browser or a WebSocket where it can set headers, and never
 * sees the provider key.
 */

/** PCM rate the Realtime API takes over a WebSocket. */
export const OPENAI_REALTIME_SAMPLE_RATE = 24_000;
/** How long a client has to connect with its secret; the session then runs on. */
const CLIENT_SECRET_SECONDS = 10 * 60;
/** A pause this long ends a stretch of text. */
const SILENCE_MILLISECONDS = 500;
const MINT_TIMEOUT_MILLISECONDS = 15_000;

/** Models a Realtime session can transcribe with as audio streams in. */
export function openAiRealtimeTranscribes(model: string): boolean {
  return /^gpt-4o(?:-mini)?-transcribe(?:-\d{4}-\d{2}-\d{2})?$/u.test(model);
}

/**
 * The Realtime API takes an ISO 639-1 code. Norwegian Bokmål and Nynorsk are
 * transcribed as Norwegian.
 */
export function openAiRealtimeLanguage(tag: string | undefined): string | undefined {
  const primary = tag?.split(/[-_]/u)[0]?.toLowerCase();
  if (!primary || !/^[a-z]{2}$/u.test(primary)) return undefined;
  return primary === "nb" || primary === "nn" ? "no" : primary;
}

function mintError(providerName: string, status: number, detail: string) {
  const message = `${providerName} could not start a live transcript (HTTP ${status}${detail ? `: ${detail}` : ""})`;
  if (status === 401 || status === 403) {
    return new RecordingTranscriptionError(message, "unauthorized", false);
  }
  if (status === 404) return new RecordingTranscriptionError(message, "not_supported", false);
  if (status === 400 || status === 422) {
    return new RecordingTranscriptionError(message, "provider", false);
  }
  if (status === 429) return new RecordingTranscriptionError(message, "rate_limited", true);
  if (status >= 500) return new RecordingTranscriptionError(message, "unavailable", true);
  return new RecordingTranscriptionError(message, "provider", false);
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" ? message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

export async function createOpenAiRealtimeLiveSession(input: {
  providerName: string;
  /** The Realtime API's base: `https://api.openai.com/v1` or `https://<account>/openai/v1`. */
  baseUrl: string;
  /** How the server signs in to mint the secret. */
  headers: Record<string, string>;
  /** The model, or on Azure the deployment's name. */
  model: string;
  request: RecordingLiveSessionRequest;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<RecordingLiveSessionGrant> {
  const base = input.baseUrl.replace(/\/+$/u, "");
  const language = openAiRealtimeLanguage(input.request.language);
  const timeout = AbortSignal.timeout(MINT_TIMEOUT_MILLISECONDS);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${base}/realtime/client_secrets`, {
      method: "POST",
      headers: { ...input.headers, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_SECONDS },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_REALTIME_SAMPLE_RATE },
              transcription: { model: input.model, ...(language ? { language } : {}) },
              turn_detection: { type: "server_vad", silence_duration_ms: SILENCE_MILLISECONDS },
            },
          },
        },
      }),
      signal: input.request.signal ? AbortSignal.any([input.request.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (input.request.signal?.aborted) throw error;
    throw new RecordingTranscriptionError(
      `Could not reach ${input.providerName}`,
      timeout.aborted ? "timeout" : "network",
      true,
    );
  }
  if (!response.ok)
    throw mintError(input.providerName, response.status, await errorDetail(response));
  const body = (await response.json().catch(() => null)) as {
    value?: unknown;
    expires_at?: unknown;
  } | null;
  if (typeof body?.value !== "string" || body.value.length === 0) {
    throw new RecordingTranscriptionError(
      `${input.providerName} returned no live session secret`,
      "provider",
      true,
    );
  }
  const now = input.now?.() ?? new Date();
  const expiresAt =
    typeof body.expires_at === "number" && Number.isFinite(body.expires_at)
      ? new Date(body.expires_at * 1_000)
      : new Date(now.getTime() + CLIENT_SECRET_SECONDS * 1_000);
  const socket = new URL(`${base}/realtime`);
  socket.protocol = socket.protocol === "http:" ? "ws:" : "wss:";
  socket.searchParams.set("intent", "transcription");
  return {
    protocol: "openai.realtime",
    url: socket.toString(),
    token: body.value,
    webrtcUrl: `${base}/realtime/calls`,
    audio: { encoding: "pcm_s16le", sampleRate: OPENAI_REALTIME_SAMPLE_RATE },
    expiresAt,
  };
}
