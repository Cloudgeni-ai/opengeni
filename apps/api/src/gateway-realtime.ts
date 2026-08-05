import {
  VERCEL_AI_GATEWAY_AI_SDK_BASE_URL,
  VERCEL_AI_GATEWAY_BASE_URL,
  resolveAiGatewayRealtimeModel,
  type Settings,
} from "@opengeni/config";
import {
  createSecretRedactor,
  type GatewayRealtimeInitialItem,
  type SessionRealtimeModel,
} from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
  getSessionRealtimeContinuityEntries,
  loadWorkspaceVercelAiGatewayApiKey,
  type Database,
} from "@opengeni/db";

import { openGeniRealtimeInstructions } from "./codex-realtime";
import {
  limitSessionRealtimeInitialItems,
  projectSessionRealtimeInitialItems,
} from "./session-realtime-context";

const redactGatewayRealtimePublicData = createSecretRedactor([]);

export class GatewayRealtimeBrokerError extends Error {
  constructor(
    readonly code:
      | "model_unavailable"
      | "credential_unavailable"
      | "provider_error"
      | "invalid_provider_response",
    message: string,
    readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "GatewayRealtimeBrokerError";
  }
}

export type GatewayRealtimeConnectionSecret = {
  token: string;
  url: string;
  upstreamModelId: string;
  expiresAt: number | null;
  initialItems: GatewayRealtimeInitialItem[];
  instructions: string;
};

/**
 * Gateway startup items cross into browser-owned JSON, so they use the strict
 * public profile after private/server-side history has been projected.
 */
export function redactGatewayRealtimeInitialItems(
  initialItems: readonly GatewayRealtimeInitialItem[],
): GatewayRealtimeInitialItem[] {
  const redacted = redactGatewayRealtimePublicData(initialItems) as GatewayRealtimeInitialItem[];
  return limitSessionRealtimeInitialItems(redacted);
}

export async function createGatewayRealtimeConnectionSecret(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  sessionId: string;
  model: SessionRealtimeModel;
  fetchImpl?: typeof fetch;
}): Promise<GatewayRealtimeConnectionSecret> {
  const resolved = resolveAiGatewayRealtimeModel(input.model);
  if (!resolved) {
    throw new GatewayRealtimeBrokerError(
      "model_unavailable",
      "The selected model is not an AI Gateway realtime model",
    );
  }
  const apiKey =
    resolved.source === "managed"
      ? input.settings.vercelAiGatewayApiKey
      : await loadWorkspaceVercelAiGatewayApiKey(input.db, input.settings, input.workspaceId);
  if (!apiKey) {
    throw new GatewayRealtimeBrokerError(
      "credential_unavailable",
      resolved.source === "managed"
        ? "OpenGeni Gateway voice is not configured"
        : "The workspace AI Gateway connection is unavailable",
    );
  }

  const [history, continuity, minted] = await Promise.all([
    getActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
    getSessionRealtimeContinuityEntries(input.db, input.workspaceId, input.sessionId),
    mintGatewayClientSecret({
      apiKey,
      upstreamModelId: resolved.upstreamModelId,
      fetchImpl: input.fetchImpl ?? fetch,
    }),
  ]);
  return {
    ...minted,
    upstreamModelId: resolved.upstreamModelId,
    initialItems: redactGatewayRealtimeInitialItems(
      projectSessionRealtimeInitialItems(history, continuity),
    ),
    instructions: openGeniRealtimeInstructions(),
  };
}

async function mintGatewayClientSecret(input: {
  apiKey: string;
  upstreamModelId: string;
  fetchImpl: typeof fetch;
}): Promise<{ token: string; url: string; expiresAt: number | null }> {
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
      body: JSON.stringify({ model: input.upstreamModelId, expiresIn: 120 }),
    });
  } catch {
    throw new GatewayRealtimeBrokerError(
      "provider_error",
      "AI Gateway realtime token request failed",
    );
  }
  if (!response.ok) {
    throw new GatewayRealtimeBrokerError(
      response.status === 401 || response.status === 403
        ? "credential_unavailable"
        : "provider_error",
      response.status === 401 || response.status === 403
        ? "AI Gateway credentials were rejected"
        : "AI Gateway realtime token request failed",
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
    throw new GatewayRealtimeBrokerError(
      "invalid_provider_response",
      "AI Gateway returned an invalid realtime token",
      response.status,
    );
  }
  const url = new URL(`${VERCEL_AI_GATEWAY_AI_SDK_BASE_URL.replace(/^http/, "ws")}/realtime-model`);
  url.searchParams.set("ai-model-id", input.upstreamModelId);
  return {
    token,
    url: url.toString(),
    expiresAt: typeof expiresAt === "number" ? expiresAt : null,
  };
}
