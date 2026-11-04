import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  CredentialProviderResponse,
  normalizeCredentialProviderMcpUrl,
  OPENGENI_SIGNATURE_HEADER,
  OPENGENI_TEST_REQUEST_NIL_ID,
  signOpenGeniPayload,
  type CredentialProviderRequest,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  resolveWorkspaceCredentialProvider,
  type Database,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";

/**
 * Headers for a workspace MCP event source that listens to a server by URL.
 * The workspace credential provider signs it in with a request that is not a
 * run (`purpose: "event_subscription"`): the run ids are the nil UUID, the one
 * server is named in `mcpServers`, and `eventSubscription` names the source.
 * Headers are kept until shortly before they expire, and a rejected
 * credential asks again with `forceRefresh`.
 */

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_LIFETIME_MS = 30 * 60_000;
const RENEW_BEFORE_MS = 5 * 60_000;
const cache = new Map<string, { headers: Record<string, string>; until: number }>();

export type EventSubscriptionCredentialDeps = {
  db: Database;
  settings: Settings;
  /** Replaces the pinned provider transport, for tests. */
  providerFetch?: typeof pinnedFetch;
};

export type EventSubscriptionCredentialTarget = {
  sourceId: string;
  accountId: string;
  workspaceId: string;
  serverId: string;
  serverUrl: string;
};

export async function eventSubscriptionCredentialHeaders(
  deps: EventSubscriptionCredentialDeps,
  target: EventSubscriptionCredentialTarget,
  forceRefresh: boolean,
): Promise<Record<string, string>> {
  const key = `${target.workspaceId}:${target.sourceId}:${target.serverUrl}`;
  const cached = cache.get(key);
  if (!forceRefresh && cached && cached.until > Date.now()) return cached.headers;
  cache.delete(key);
  const scope = { accountId: target.accountId, workspaceId: target.workspaceId };
  const provider = await resolveWorkspaceCredentialProvider(deps.db, scope);
  if (!provider?.enabled) {
    throw new EventSourceBlockedError(
      eventStatusReason(
        "reconnect",
        "This source signs in through the workspace credential provider, which is not set up or is turned off",
      ),
    );
  }
  const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
  if (!encryptionKey) {
    throw new Error(
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required to use a workspace credential provider",
    );
  }
  const initiator = { kind: "service" as const, subjectId: "event_subscription" };
  const request: CredentialProviderRequest = {
    type: "credentials.request",
    lane: "workspaceId" in provider && provider.workspaceId ? "workspace" : "organization",
    mcpServers: [{ id: target.serverId, url: target.serverUrl }],
    purpose: "event_subscription",
    forceRefresh,
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    sessionId: OPENGENI_TEST_REQUEST_NIL_ID,
    rootSessionId: OPENGENI_TEST_REQUEST_NIL_ID,
    parentSessionId: null,
    turnId: OPENGENI_TEST_REQUEST_NIL_ID,
    attemptId: OPENGENI_TEST_REQUEST_NIL_ID,
    initiator,
    initiatorContext: { kind: "service", initiator, context: {} },
    initiatingHumanSubjectId: null,
    initiatingHuman: null,
    sandboxBackend: "none",
    sandboxOs: "linux",
    eventSubscription: { sourceId: target.sourceId, serverUrl: target.serverUrl },
  };
  const body = JSON.stringify(request);
  const secret = decryptEnvironmentValue(encryptionKey, provider.secretEncrypted);
  const response = await (deps.providerFetch ?? pinnedFetch)(
    provider.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "OpenGeni-CredentialProvider/1",
        [OPENGENI_SIGNATURE_HEADER]: await signOpenGeniPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(provider.timeoutMs),
    },
    deps.settings,
    { label: "Workspace credential provider", requireHttpsOutsideLocalTest: true },
  );
  const text = await response.text();
  if (!response.ok || text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Workspace credential provider returned HTTP ${response.status}`);
  }
  const parsed = CredentialProviderResponse.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Workspace credential provider returned an invalid body");
  const url = normalizeCredentialProviderMcpUrl(target.serverUrl);
  const entry =
    parsed.data.status === "ok" ? parsed.data.mcp?.find((item) => item.url === url) : undefined;
  if (!entry) {
    throw new EventSourceBlockedError(
      eventStatusReason(
        "reconnect",
        "The workspace credential provider didn't sign this source in to its server",
      ),
    );
  }
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  const until = Number.isFinite(expiresAt)
    ? expiresAt - RENEW_BEFORE_MS
    : Date.now() + DEFAULT_LIFETIME_MS;
  cache.set(key, { headers: entry.headers, until });
  return entry.headers;
}
