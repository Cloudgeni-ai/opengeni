import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

type ClientSecretPayload = {
  sessionId: string;
  language?: string;
  diarization: boolean;
  privacy: {
    retainAudio: false;
    retainTranscript: false;
    trainingAllowed: false;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function parsePayload(request: Request): Promise<ClientSecretPayload> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HTTPException(400, { message: "invalid transcription request" });
  }
  const body = record(value);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const language = typeof body?.language === "string" ? body.language.trim() : undefined;
  const diarization = body?.diarization ?? false;
  const privacy = record(body?.privacy);
  if (!sessionId || sessionId.length > 200) {
    throw new HTTPException(400, { message: "invalid transcription sessionId" });
  }
  if (language !== undefined && (!language || language.length > 35)) {
    throw new HTTPException(400, { message: "invalid transcription language" });
  }
  if (typeof diarization !== "boolean") {
    throw new HTTPException(400, { message: "invalid transcription diarization option" });
  }
  if (diarization) {
    throw new HTTPException(422, {
      message: "diarization is not supported by the realtime transcription prototype",
    });
  }
  if (
    privacy?.retainAudio !== false ||
    privacy?.retainTranscript !== false ||
    privacy?.trainingAllowed !== false
  ) {
    throw new HTTPException(422, {
      message: "the transcription prototype requires no-retention and no-training defaults",
    });
  }
  if (privacy.region !== undefined || privacy.dataResidency !== undefined) {
    throw new HTTPException(422, {
      message: "region and data residency are not supported by the transcription prototype",
    });
  }
  return {
    sessionId,
    ...(language ? { language } : {}),
    diarization,
    privacy: {
      retainAudio: false,
      retainTranscript: false,
      trainingAllowed: false,
    },
  };
}

function isDirectOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  const normalized = baseUrl.replace(/\/+$/u, "");
  return normalized === "https://api.openai.com" || normalized === "https://api.openai.com/v1";
}

async function safetyIdentifier(workspaceId: string, subjectId: string): Promise<string> {
  const input = new TextEncoder().encode(`${workspaceId}:${subjectId}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function registerTranscriptionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/transcription/client-secret", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    // Authorization precedes body parsing, configuration inspection with side
    // effects, and every provider call. sessions:control already gates paid
    // provider-backed session actions and is narrower than workspace:admin.
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");

    if (deps.settings.openaiProvider !== "openai") {
      throw new HTTPException(409, {
        message: "realtime transcription is not available for the configured provider",
      });
    }
    if (!isDirectOpenAIBaseUrl(deps.settings.openaiBaseUrl)) {
      throw new HTTPException(409, {
        message: "realtime transcription does not support custom OpenAI base URLs",
      });
    }
    const apiKey = deps.settings.openaiApiKey;
    if (!apiKey) {
      throw new HTTPException(503, { message: "realtime transcription is not configured" });
    }

    const payload = await parsePayload(c.req.raw);
    const response = await globalThis.fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "openai-safety-identifier": await safetyIdentifier(workspaceId, grant.subjectId),
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: {
                model: OPENAI_TRANSCRIPTION_MODEL,
                ...(payload.language ? { language: payload.language } : {}),
              },
              turn_detection: {
                type: "server_vad",
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                threshold: 0.5,
              },
            },
          },
        },
      }),
    });
    if (!response.ok) {
      throw new HTTPException(502, { message: "transcription provider rejected the request" });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new HTTPException(502, { message: "transcription provider returned invalid data" });
    }
    const body = record(raw);
    const session = record(body?.session);
    const value = typeof body?.value === "string" ? body.value : "";
    const expiresAt = body?.expires_at;
    const providerSessionId = typeof session?.id === "string" ? session.id : "";
    if (
      !value ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      !providerSessionId ||
      session?.type !== "transcription"
    ) {
      throw new HTTPException(502, { message: "transcription provider returned invalid data" });
    }

    c.header("cache-control", "no-store");
    return c.json({ value, expiresAt, providerSessionId });
  });
}
