import {
  OPENAI_REALTIME_TRANSCRIPTION_ENDPOINT,
  resolveWorkspaceTranscriptionPolicy,
} from "@opengeni/contracts";
import { configuredStaticUsageLimits } from "@opengeni/config";
import { requireAccessGrant, requireLimit, type ApiRouteDeps } from "@opengeni/core";
import {
  activateTranscriptionGrant,
  getSession,
  recordAuditEvent,
  reportTranscriptionGrantUsage,
  requireWorkspace,
  reserveTranscriptionGrant,
  settleTranscriptionGrant,
  type TranscriptionGrantStatus,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const OPENAI_CLIENT_SECRETS_URL = `${OPENAI_REALTIME_TRANSCRIPTION_ENDPOINT}/client_secrets`;
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ClientSecretPayload = {
  sessionId: string;
  requestId: string;
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

function requiredString(
  body: Record<string, unknown> | null,
  key: string,
  maxLength: number,
): string {
  const value = typeof body?.[key] === "string" ? body[key].trim() : "";
  if (!value || value.length > maxLength) {
    throw new HTTPException(400, { message: `invalid transcription ${key}` });
  }
  return value;
}

function requiredUuid(body: Record<string, unknown> | null, key: string): string {
  const value = requiredString(body, key, 36);
  if (!UUID_PATTERN.test(value)) {
    throw new HTTPException(400, { message: `invalid transcription ${key}` });
  }
  return value;
}

async function parseClientSecretPayload(request: Request): Promise<ClientSecretPayload> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HTTPException(400, { message: "invalid transcription request" });
  }
  const body = record(value);
  const sessionId = requiredUuid(body, "sessionId");
  const requestId = requiredString(body, "requestId", 200);
  const language = typeof body?.language === "string" ? body.language.trim() : undefined;
  const diarization = body?.diarization ?? false;
  const privacy = record(body?.privacy);
  if (!/^[a-zA-Z0-9:._-]+$/u.test(requestId)) {
    throw new HTTPException(400, { message: "invalid transcription requestId" });
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
      message: "request-level region and data residency overrides are not supported",
    });
  }
  return {
    sessionId,
    requestId,
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

async function auditDenial(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId?: string;
    code: string;
  },
): Promise<void> {
  await recordAuditEvent(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    action: "transcription.grant.denied",
    targetType: "session",
    targetId: input.sessionId ?? null,
    metadata: { code: input.code },
  });
}

function admissionStatus(code: string): 409 | 429 {
  return code.includes("concurrency") || code.includes("rate") || code.includes("monthly")
    ? 429
    : 409;
}

function transcriptionPlatformLimits(settings: ApiRouteDeps["settings"]) {
  if (settings.usageLimitsMode !== "static" && settings.usageLimitsMode !== "managed") {
    return undefined;
  }
  const limits = configuredStaticUsageLimits(settings);
  return {
    ...(limits.maxActiveTranscriptionGrantsPerWorkspace === undefined
      ? {}
      : { maxActiveGrantsPerWorkspace: limits.maxActiveTranscriptionGrantsPerWorkspace }),
    ...(limits.maxTranscriptionIssuancesPerMinutePerSubject === undefined
      ? {}
      : {
          maxIssuancesPerMinutePerSubject: limits.maxTranscriptionIssuancesPerMinutePerSubject,
        }),
    ...(limits.maxMonthlyTranscriptionSecondsPerWorkspace === undefined
      ? {}
      : {
          maxMonthlyDurationSecondsPerWorkspace: limits.maxMonthlyTranscriptionSecondsPerWorkspace,
        }),
    ...(limits.maxMonthlyTranscriptionCostMicrosPerAccount === undefined
      ? {}
      : {
          maxMonthlyTranscriptionCostMicrosPerAccount:
            limits.maxMonthlyTranscriptionCostMicrosPerAccount,
        }),
    ...(limits.maxMonthlyCostMicrosPerAccount === undefined
      ? {}
      : { maxMonthlyCostMicrosPerAccount: limits.maxMonthlyCostMicrosPerAccount }),
  };
}

async function reconcileProviderFailure(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    grantId: string;
    status: "error" | "provider_rejected";
  },
): Promise<void> {
  try {
    await settleTranscriptionGrant(deps.db, input);
  } catch {
    await recordAuditEvent(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      action: "transcription.grant.reconciliation_failed",
      targetType: "transcription_grant",
      targetId: input.grantId,
      metadata: { sessionId: input.sessionId, attemptedStatus: input.status },
    }).catch(() => undefined);
  }
}

function settlementStatus(
  value: unknown,
): Exclude<
  TranscriptionGrantStatus,
  "reserved" | "active" | "expired" | "provider_rejected"
> | null {
  return value === "completed" ||
    value === "cancelled" ||
    value === "error" ||
    value === "provider_closed" ||
    value === "replaced"
    ? value
    : null;
}

export function registerTranscriptionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/transcription/client-secret", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    // Authorization always precedes body parsing, configuration inspection,
    // database admission, and every provider call.
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const payload = await parseClientSecretPayload(c.req.raw);
    const workspace = await requireWorkspace(deps.db, workspaceId);
    const policy = resolveWorkspaceTranscriptionPolicy(workspace.settings);
    if (!policy) {
      await auditDenial(deps, { ...grant, sessionId: payload.sessionId, code: "policy_disabled" });
      throw new HTTPException(409, { message: "workspace transcription is not enabled" });
    }

    if (deps.settings.openaiProvider !== "openai") {
      await auditDenial(deps, {
        ...grant,
        sessionId: payload.sessionId,
        code: "provider_mismatch",
      });
      throw new HTTPException(409, {
        message: "realtime transcription is not available for the configured provider",
      });
    }
    if (!isDirectOpenAIBaseUrl(deps.settings.openaiBaseUrl)) {
      await auditDenial(deps, {
        ...grant,
        sessionId: payload.sessionId,
        code: "endpoint_mismatch",
      });
      throw new HTTPException(409, {
        message: "realtime transcription does not support custom OpenAI base URLs",
      });
    }
    if (
      policy.endpoint !== OPENAI_REALTIME_TRANSCRIPTION_ENDPOINT ||
      !deps.settings.openaiProjectId ||
      policy.providerProjectId !== deps.settings.openaiProjectId
    ) {
      await auditDenial(deps, {
        ...grant,
        sessionId: payload.sessionId,
        code: "project_or_endpoint_not_eligible",
      });
      throw new HTTPException(409, {
        message: "configured transcription project or endpoint is not approved by workspace policy",
      });
    }
    const apiKey = deps.settings.openaiApiKey;
    if (!apiKey) {
      await auditDenial(deps, { ...grant, sessionId: payload.sessionId, code: "key_missing" });
      throw new HTTPException(503, { message: "realtime transcription is not configured" });
    }

    const workspaceSession = await getSession(deps.db, workspaceId, payload.sessionId);
    if (!workspaceSession) {
      await auditDenial(deps, {
        ...grant,
        sessionId: payload.sessionId,
        code: "session_not_found",
      });
      throw new HTTPException(404, { message: "transcription session not found" });
    }
    try {
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        action: "transcription:issue",
        quantity: policy.limits.maxSessionDurationSeconds,
        costMicros: policy.limits.reservationCostMicros,
      });
    } catch (error) {
      await auditDenial(deps, {
        ...grant,
        sessionId: payload.sessionId,
        code: "canonical_limit_denied",
      });
      throw error;
    }

    const platformLimits = transcriptionPlatformLimits(deps.settings);
    const admission = await reserveTranscriptionGrant(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: payload.sessionId,
      subjectId: grant.subjectId,
      requestId: payload.requestId,
      provider: "openai",
      providerProjectId: policy.providerProjectId,
      endpoint: policy.endpoint,
      ...(platformLimits ? { platformLimits } : {}),
    });
    if (!admission.allowed) {
      throw new HTTPException(admissionStatus(admission.code), { message: admission.message });
    }

    let response: Response;
    const providerController = new AbortController();
    const abortProvider = () => providerController.abort();
    if (c.req.raw.signal.aborted) abortProvider();
    c.req.raw.signal.addEventListener("abort", abortProvider, { once: true });
    const providerTimeout = setTimeout(
      () => providerController.abort(),
      PROVIDER_REQUEST_TIMEOUT_MS,
    );
    try {
      response = await globalThis.fetch(OPENAI_CLIENT_SECRETS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "openai-project": policy.providerProjectId,
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
        signal: providerController.signal,
      });
    } catch {
      await reconcileProviderFailure(deps, {
        ...grant,
        grantId: admission.grant.id,
        sessionId: payload.sessionId,
        status: "provider_rejected",
      });
      throw new HTTPException(502, { message: "transcription provider request failed" });
    } finally {
      clearTimeout(providerTimeout);
      c.req.raw.signal.removeEventListener("abort", abortProvider);
    }
    if (!response.ok) {
      await reconcileProviderFailure(deps, {
        ...grant,
        grantId: admission.grant.id,
        sessionId: payload.sessionId,
        status: "provider_rejected",
      });
      throw new HTTPException(502, { message: "transcription provider rejected the request" });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    const body = record(raw);
    const providerSession = record(body?.session);
    const value = typeof body?.value === "string" ? body.value : "";
    const expiresAt = body?.expires_at;
    const providerSessionId = typeof providerSession?.id === "string" ? providerSession.id : "";
    const nowEpochSeconds = Date.now() / 1_000;
    if (
      !value ||
      value.length > 4_096 ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= nowEpochSeconds ||
      expiresAt > nowEpochSeconds + 300 ||
      !providerSessionId ||
      providerSessionId.length > 200 ||
      providerSession?.type !== "transcription"
    ) {
      await reconcileProviderFailure(deps, {
        ...grant,
        grantId: admission.grant.id,
        sessionId: payload.sessionId,
        status: "provider_rejected",
      });
      throw new HTTPException(502, { message: "transcription provider returned invalid data" });
    }

    try {
      await activateTranscriptionGrant(deps.db, {
        ...grant,
        grantId: admission.grant.id,
        sessionId: payload.sessionId,
        providerSessionId,
        clientSecretExpiresAt: new Date(expiresAt * 1_000),
      });
    } catch {
      // The provider credential is deliberately not returned if durable
      // activation fails. The conservative reservation remains billable, while
      // terminal reconciliation releases the session concurrency slot.
      await reconcileProviderFailure(deps, {
        ...grant,
        grantId: admission.grant.id,
        sessionId: payload.sessionId,
        status: "error",
      });
      throw new HTTPException(503, { message: "transcription admission could not be finalized" });
    }

    c.header("cache-control", "no-store");
    return c.json({
      value,
      expiresAt,
      providerSessionId,
      grantId: admission.grant.id,
      maxSessionDurationSeconds: admission.policy.limits.maxSessionDurationSeconds,
    });
  });

  app.post("/v1/workspaces/:workspaceId/transcription/grants/:grantId/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const body = record(await c.req.json().catch(() => null));
    const sessionId = requiredUuid(body, "sessionId");
    const grantId = c.req.param("grantId");
    if (!UUID_PATTERN.test(grantId)) {
      throw new HTTPException(400, { message: "invalid transcription grantId" });
    }
    const providerSessionId = requiredString(body, "providerSessionId", 200);
    const providerEventId = requiredString(body, "providerEventId", 200);
    const durationSeconds = body?.durationSeconds;
    if (
      typeof durationSeconds !== "number" ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 3_600
    ) {
      throw new HTTPException(400, { message: "invalid transcription usage" });
    }
    try {
      return c.json(
        await reportTranscriptionGrantUsage(deps.db, {
          ...grant,
          grantId,
          sessionId,
          providerSessionId,
          providerEventId,
          durationSeconds,
        }),
      );
    } catch {
      throw new HTTPException(404, { message: "transcription grant not found" });
    }
  });

  app.post("/v1/workspaces/:workspaceId/transcription/grants/:grantId/settle", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const body = record(await c.req.json().catch(() => null));
    const sessionId = requiredUuid(body, "sessionId");
    const grantId = c.req.param("grantId");
    if (!UUID_PATTERN.test(grantId)) {
      throw new HTTPException(400, { message: "invalid transcription grantId" });
    }
    const providerSessionId = requiredString(body, "providerSessionId", 200);
    const status = settlementStatus(body?.status);
    if (!status) {
      throw new HTTPException(400, { message: "invalid transcription settlement status" });
    }
    try {
      const settled = await settleTranscriptionGrant(deps.db, {
        ...grant,
        grantId,
        sessionId,
        providerSessionId,
        status,
      });
      return c.json({ grantId: settled.id, status: settled.status });
    } catch {
      throw new HTTPException(409, { message: "transcription grant could not be settled" });
    }
  });
}
