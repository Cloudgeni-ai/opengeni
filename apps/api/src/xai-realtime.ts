import { SUPERGROK_REALTIME_MODEL_ID, type Settings } from "@opengeni/config";
import type { GatewayRealtimeInitialItem } from "@opengeni/contracts";
import {
  getActiveSessionHistoryItems,
  getSessionRealtimeContinuityEntries,
  getXaiSessionAccountPin,
  readSubscriptionCoreProviderRouteForWorkspace,
  readSubscriptionCoreSessionOwner,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  setXaiSessionAccountPin,
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
  type XaiFetch,
  type XaiProxyAuthContext,
} from "@opengeni/xai-subscription";

import { openGeniRealtimeInstructions } from "./codex-realtime";
import { projectSessionRealtimeInitialItems } from "./session-realtime-context";
import { buildXaiSubscriptionAuthorization } from "./xai-subscription-auth";

const UPSTREAM_MODEL_ID = "grok-voice-think-fast-2.0";

export class XaiRealtimeBrokerError extends Error {
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
    this.name = "XaiRealtimeBrokerError";
  }
}

export type XaiRealtimeConnectionSecret = {
  token: string;
  url: string;
  upstreamModelId: string;
  expiresAt: number | null;
  initialItems: GatewayRealtimeInitialItem[];
  instructions: string;
};

export async function createXaiRealtimeConnectionSecret(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<XaiRealtimeConnectionSecret> {
  if (input.model !== SUPERGROK_REALTIME_MODEL_ID) {
    throw new XaiRealtimeBrokerError(
      "model_unavailable",
      "The selected model is not a connected SuperGrok realtime model",
    );
  }
  const route = await readSubscriptionCoreProviderRouteForWorkspace(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
  });
  if (route === "maintenance") {
    throw new XaiRealtimeBrokerError(
      "credential_unavailable",
      "No eligible connected SuperGrok account is available",
    );
  }
  if (route === "core") return await createCoreXaiRealtimeConnectionSecret(input);
  const authoritySnapshot = await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(
    input.db,
    { workspaceId: input.workspaceId, subjectId: input.subjectId },
  );
  let pin = await getXaiSessionAccountPin(input.db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    authoritySnapshot,
  });
  let auth: Awaited<ReturnType<typeof buildXaiSubscriptionAuthorization>>;
  try {
    auth = await buildXaiSubscriptionAuthorization({
      db: input.db,
      settings: input.settings,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      shardKey: input.sessionId,
      pinnedCredentialId: pin?.pinnedCredentialId ?? null,
      pinSource: pin?.pinSource === "manual" || pin?.pinSource === "policy" ? pin.pinSource : null,
      authoritySnapshot,
      sessionId: input.sessionId,
      ...(input.fetchImpl ? { fetch: input.fetchImpl as XaiFetch } : {}),
    });
    if (
      auth.rotationEnabled &&
      pin?.pinSource !== "manual" &&
      pin?.pinnedCredentialId !== auth.credentialId
    ) {
      try {
        pin = await setXaiSessionAccountPin(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          sessionId: input.sessionId,
          authoritySnapshot,
          credentialId: auth.credentialId,
          pinSource: "policy",
          expectedVersion: pin?.version ?? null,
        });
      } catch {
        const current = await getXaiSessionAccountPin(input.db, {
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          sessionId: input.sessionId,
          authoritySnapshot,
        });
        if (current?.pinSource === "manual" && current.pinnedCredentialId !== auth.credentialId) {
          auth = await buildXaiSubscriptionAuthorization({
            db: input.db,
            settings: input.settings,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            shardKey: input.sessionId,
            pinnedCredentialId: current.pinnedCredentialId,
            pinSource: "manual",
            authoritySnapshot,
            sessionId: input.sessionId,
            ...(input.fetchImpl ? { fetch: input.fetchImpl as XaiFetch } : {}),
          });
        }
      }
    }
  } catch {
    throw new XaiRealtimeBrokerError(
      "credential_unavailable",
      "No eligible connected SuperGrok account is available",
    );
  }

  const [history, continuity, minted] = await Promise.all([
    getActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
    getSessionRealtimeContinuityEntries(input.db, input.workspaceId, input.sessionId),
    mintXaiClientSecret({
      context: auth.context,
      fetchImpl: input.fetchImpl ?? fetch,
    }),
  ]);
  return {
    ...minted,
    upstreamModelId: UPSTREAM_MODEL_ID,
    initialItems: projectSessionRealtimeInitialItems(history, continuity),
    instructions: openGeniRealtimeInstructions(),
  };
}

/**
 * SuperGrok realtime on the shared subscription core (the M3 Codex rule,
 * EP-N05/N07/S17): the session's recorded owner (never the caller), shared
 * organization- or workspace-scoped connections only (decision 3), a
 * `realtime` operation lease held through the client-secret request, with
 * refresh under the per-connection lock. The session binding is never read
 * for placement beyond an explicit choice and never written (decision 6).
 */
async function createCoreXaiRealtimeConnectionSecret(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<XaiRealtimeConnectionSecret> {
  const unavailable = () =>
    new XaiRealtimeBrokerError(
      "credential_unavailable",
      "No eligible connected SuperGrok account is available",
    );
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
      fetchImpl: input.fetchImpl ?? fetch,
    },
    async ({ resolver, fetch: requestFetch, fence }) =>
      await Promise.all([
        getActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
        getSessionRealtimeContinuityEntries(input.db, input.workspaceId, input.sessionId),
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
  const [history, continuity, minted] = ran.value;
  return {
    ...minted,
    upstreamModelId: UPSTREAM_MODEL_ID,
    initialItems: projectSessionRealtimeInitialItems(history, continuity),
    instructions: openGeniRealtimeInstructions(),
  };
}

async function mintXaiClientSecret(input: {
  context: Pick<XaiProxyAuthContext, "getToken" | "refresh">;
  fetchImpl: SubscriptionCoreFetch;
}): Promise<{ token: string; url: string; expiresAt: number | null }> {
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
      body: JSON.stringify({ expires_after: { seconds: 120 } }),
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
    // A core pre-dispatch fence refusal is already typed (legacy never raises one).
    if (error instanceof XaiRealtimeBrokerError) throw error;
    throw new XaiRealtimeBrokerError("provider_error", "xAI realtime token request failed");
  }
  if (!response.ok) {
    throw new XaiRealtimeBrokerError(
      response.status === 401 || response.status === 403
        ? "credential_unavailable"
        : "provider_error",
      response.status === 401 || response.status === 403
        ? "SuperGrok credentials were rejected"
        : "xAI realtime token request failed",
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.value;
  const expiresAt = normalizeExpiry(body?.expires_at ?? body?.expiresAt);
  if (typeof token !== "string" || token.length === 0) {
    throw new XaiRealtimeBrokerError(
      "invalid_provider_response",
      "xAI returned an invalid realtime token",
      response.status,
    );
  }
  const url = new URL("wss://api.x.ai/v1/realtime");
  url.searchParams.set("model", UPSTREAM_MODEL_ID);
  return { token, url: url.toString(), expiresAt };
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
