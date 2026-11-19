/**
 * Logins for an organization agent's tool servers, resolved once per turn.
 *
 * A chat that runs an organization agent version has that version's tool
 * servers as ordinary session MCP servers (id = tool server key, created with
 * no credentials). Before tools are prepared, each one gets its login:
 *
 * - `per_user`: the workspace credential provider (it sets headers at the
 *   request boundary), then the stored login of the end user who started the
 *   turn (OAuth refreshed when it expires within five minutes, under a refresh
 *   lease; no row lock is held during the token request), then the chat's own
 *   headers. Never the organization's shared key.
 * - `shared_key`: the organization's shared headers.
 * - `none`: nothing.
 *
 * A server left without a login is attached as unavailable: its tools are
 * hidden, the model is told the person's sign-in is missing, and the chat
 * records `session.tool_server.unavailable`. Secrets never reach logs,
 * events or the model.
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  isConsoleTestChatSubject,
  normalizeCredentialProviderMcpUrl,
  type OrgToolServerUnavailableReason,
  type ToolRef,
} from "@opengeni/contracts";
import { endUserLoginHeaders } from "@opengeni/core";
import {
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  listOrgToolServersByKey,
  markEndUserToolCredentialsUsed,
  readEndUserToolCredential,
  readOrgAgentVersion,
  readSessionLoginOwners,
  refreshEndUserToolCredential,
  type Database,
  type EndUserToolCredentialRow,
  type OrgToolServerRuntime,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import {
  recordOrgAgentCredentialSource,
  type Observability,
  type OrgAgentCredentialOutcome,
  type OrgAgentCredentialSource,
} from "@opengeni/observability";
import type { UnavailableMcpConnector } from "./errors";

/** Refresh a stored OAuth login that expires within this window. */
export const END_USER_LOGIN_REFRESH_WINDOW_MS = 5 * 60_000;
const REFRESH_LOCK_RETRY_MS = 500;
const REFRESH_TIMEOUT_MS = 10_000;

type McpServerSetting = Settings["mcpServers"][number];

export type OrgToolServerUnavailable = {
  serverKey: string;
  name: string;
  reason: OrgToolServerUnavailableReason;
};

export type OrgAgentToolLoginsResult = {
  mcpServers: McpServerSetting[];
  turnTools: ToolRef[];
  unavailableMcpConnectors: UnavailableMcpConnector[];
  unavailable: OrgToolServerUnavailable[];
};

export type OrgAgentToolLoginsInput = {
  db: Database;
  settings: Settings;
  observability?: Observability | null;
  accountId: string;
  workspaceId: string;
  /** The organization agent version frozen for this turn, or null. */
  orgAgent: { agentId: string; version: number } | null;
  /** The end user the chat acts for (`external_user:...`), or null. */
  endUserSubjectId: string | null;
  /**
   * The chat and who started this turn. The chat's own login headers run
   * only for its creator, or for a turn no person started (an API key, a
   * schedule, a worker); another person's turn never uses them.
   */
  chat?: {
    sessionId: string;
    turnStarterSubjectId: string | null | undefined;
    /** Who started this turn (`turn.initiator.subjectId`), person or not. */
    turnInitiatorSubjectId?: string | null | undefined;
  };
  mcpServers: readonly McpServerSetting[];
  turnTools: readonly ToolRef[];
  /** Whether the workspace credential provider supplies this server's login. */
  providerManaged: (serverId: string) => boolean;
  /** Record `session.tool_server.unavailable` for one server. */
  publishUnavailable: (payload: OrgToolServerUnavailable) => Promise<void>;
  /** Test seams. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function isEndUserSubject(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("external_user:");
}

/** A person: an end user or an Opengeni member (not a key, service or worker). */
function isPersonSubject(value: string | null | undefined): value is string {
  return (
    typeof value === "string" && (value.startsWith("external_user:") || value.startsWith("user:"))
  );
}

/**
 * Whose stored logins this turn uses: the person who started the turn when
 * that is an end user. A turn another person started (another end user, or an
 * Opengeni member) uses no stored login, so one person's login never runs for
 * another person's message. Only a turn no person started (an API key, a
 * schedule, a worker) falls back to the chat's end user.
 */
export function orgAgentEndUserSubject(
  sessionScopeSubjectId: string | null | undefined,
  initiatingHumanSubjectId: string | null | undefined,
): string | null {
  if (isPersonSubject(initiatingHumanSubjectId)) {
    return isEndUserSubject(initiatingHumanSubjectId) ? initiatingHumanSubjectId : null;
  }
  return isEndUserSubject(sessionScopeSubjectId) ? sessionScopeSubjectId : null;
}

/**
 * Whether this turn may use the chat's own login headers: always when no
 * person started it; otherwise only when that person created the chat or is
 * the end user it acts for. Another person's turn never runs them.
 */
async function orgAgentChatHeadersAllowed(input: OrgAgentToolLoginsInput): Promise<boolean> {
  const starter = input.chat?.turnStarterSubjectId;
  if (!input.chat) return !isPersonSubject(starter);
  const owners = await readSessionLoginOwners(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.chat.sessionId,
  });
  // A Console test chat's headers are its tester's: they run only for turns
  // that tester's own test chat principal started.
  if (owners && isConsoleTestChatSubject(owners.creatorSubjectId)) {
    return input.chat.turnInitiatorSubjectId === owners.creatorSubjectId;
  }
  if (!isPersonSubject(starter)) return true;
  return (
    owners !== null && (owners.creatorSubjectId === starter || owners.scopeSubjectId === starter)
  );
}

function sameUrl(left: string, right: string): boolean {
  try {
    return normalizeCredentialProviderMcpUrl(left) === normalizeCredentialProviderMcpUrl(right);
  } catch {
    return left === right;
  }
}

function versionToolServerKeys(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const servers = (config as Record<string, unknown>)["toolServers"];
  if (!Array.isArray(servers)) return [];
  return servers
    .map((server) =>
      server && typeof server === "object" ? (server as Record<string, unknown>)["server"] : null,
    )
    .filter((key): key is string => typeof key === "string");
}

function hasHeaders(headers: Record<string, string> | undefined): boolean {
  return Boolean(headers && Object.keys(headers).length > 0);
}

/**
 * Resolve logins for this turn. Returns null for every chat that runs no
 * organization agent (nothing is read or changed).
 */
export async function resolveOrgAgentToolLogins(
  input: OrgAgentToolLoginsInput,
): Promise<OrgAgentToolLoginsResult | null> {
  if (!input.orgAgent) return null;
  const version = await readOrgAgentVersion(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    agentId: input.orgAgent.agentId,
    version: input.orgAgent.version,
  });
  const keys = versionToolServerKeys(version?.config).filter((key) =>
    input.mcpServers.some((server) => server.id === key),
  );
  if (keys.length === 0) return null;
  const toolServers = await listOrgToolServersByKey(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    keys,
  });
  const encryptionKey = environmentsEncryptionKeyBytes(input.settings);
  const now = input.now ?? Date.now;
  const record = (source: OrgAgentCredentialSource, outcome: OrgAgentCredentialOutcome) =>
    recordOrgAgentCredentialSource(input.observability, source, outcome);

  // Read once, only when a server would fall back to the chat's headers.
  let chatHeadersAllowedResult: Promise<boolean> | null = null;
  const chatHeadersAllowed = () =>
    (chatHeadersAllowedResult ??= orgAgentChatHeadersAllowed(input).catch(() => false));

  const mcpServers: McpServerSetting[] = [];
  const unavailable: OrgToolServerUnavailable[] = [];
  const usedCredentialIds: string[] = [];
  for (const server of input.mcpServers) {
    const toolServer = toolServers.get(server.id);
    // Not the agent's server (or replaced by the chat with its own URL).
    if (!keys.includes(server.id) || !toolServer || !sameUrl(server.url, toolServer.url)) {
      mcpServers.push(server);
      continue;
    }
    const name = server.name ?? toolServer.name;
    if (toolServer.authMode === "none") {
      record("none", "used");
      mcpServers.push(server);
      continue;
    }
    if (toolServer.authMode === "shared_key") {
      const shared = decryptHeaders(encryptionKey, toolServer.sharedHeadersEncrypted);
      if (shared) {
        record("shared_key", "used");
        mcpServers.push({ ...server, headers: shared });
      } else {
        record("shared_key", "missing");
        unavailable.push({ serverKey: server.id, name, reason: "missing_credentials" });
      }
      continue;
    }
    // per_user: credential provider, then the end user's stored login, then the chat's headers.
    if (input.providerManaged(server.id)) {
      record("credential_provider", "used");
      mcpServers.push(server);
      continue;
    }
    const stored = input.endUserSubjectId
      ? await storedLoginHeaders(input, toolServer, encryptionKey, now).catch(() => ({
          kind: "error" as const,
        }))
      : ({ kind: "missing" } as const);
    if (stored.kind === "ok") {
      record("end_user_store", stored.refreshed ? "refreshed" : "used");
      usedCredentialIds.push(stored.credentialId);
      mcpServers.push({ ...server, headers: stored.headers });
      continue;
    }
    if (stored.kind === "expired") record("end_user_store", "expired");
    else if (stored.kind === "refresh_failed") record("end_user_store", "refresh_failed");
    else if (stored.kind === "error") record("end_user_store", "error");
    if (hasHeaders(server.headers) && (await chatHeadersAllowed())) {
      record("chat_headers", "used");
      mcpServers.push(server);
      continue;
    }
    if (hasHeaders(server.headers)) record("chat_headers", "refused");
    const reason: OrgToolServerUnavailableReason =
      stored.kind === "expired" || stored.kind === "refresh_failed"
        ? "credentials_expired"
        : "missing_credentials";
    if (stored.kind === "missing") record("end_user_store", "missing");
    unavailable.push({ serverKey: server.id, name, reason });
  }

  const unavailableIds = new Set(unavailable.map((entry) => entry.serverKey));
  for (const entry of unavailable) {
    await input.publishUnavailable(entry).catch(() => undefined);
  }
  if (usedCredentialIds.length > 0) {
    await markEndUserToolCredentialsUsed(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      credentialIds: usedCredentialIds,
    }).catch(() => undefined);
  }
  return {
    mcpServers,
    turnTools: input.turnTools.filter((tool) => !unavailableIds.has(tool.id)),
    // The person's sign-in for the server is missing or expired.
    unavailableMcpConnectors: unavailable.map((entry) => ({
      id: entry.serverKey,
      name: entry.name,
      reason: "no_account" as const,
    })),
    unavailable,
  };
}

function decryptHeaders(
  key: Uint8Array | null,
  encrypted: string | null,
): Record<string, string> | null {
  if (!key || !encrypted) return null;
  try {
    const parsed = JSON.parse(decryptEnvironmentValue(key, encrypted)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const headers = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return Object.keys(headers).length > 0 ? headers : null;
  } catch {
    return null;
  }
}

type StoredLogin =
  | { kind: "ok"; headers: Record<string, string>; credentialId: string; refreshed: boolean }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "refresh_failed" }
  | { kind: "error" };

async function storedLoginHeaders(
  input: OrgAgentToolLoginsInput,
  toolServer: OrgToolServerRuntime,
  encryptionKey: ReturnType<typeof environmentsEncryptionKeyBytes>,
  now: () => number,
): Promise<StoredLogin> {
  if (!encryptionKey || !input.endUserSubjectId) return { kind: "missing" };
  const key: Uint8Array = encryptionKey;
  const scope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.endUserSubjectId,
    toolServerId: toolServer.id,
  };
  let credential = await readEndUserToolCredential(input.db, scope);
  if (!credential) return { kind: "missing" };
  let refreshed = false;
  const refreshBefore = new Date(now() + END_USER_LOGIN_REFRESH_WINDOW_MS);
  if (
    credential.kind === "oauth" &&
    credential.expiresAt &&
    credential.expiresAt <= refreshBefore &&
    toolServer.oauthRefresh
  ) {
    const attempt = () =>
      refreshEndUserToolCredential(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        credentialId: credential!.id,
        refreshBefore,
        refresh: async (current) => await refreshOAuthLogin(input, toolServer, key, current, now),
      });
    let outcome = await attempt();
    // Another turn holds the refresh. A login that still works is used now;
    // an expired one waits (up to one token request) for what it writes.
    for (
      let waited = 0;
      outcome.outcome === "locked" && waited <= REFRESH_TIMEOUT_MS;
      waited += REFRESH_LOCK_RETRY_MS
    ) {
      const reread = await readEndUserToolCredential(input.db, scope);
      if (!reread) return { kind: "missing" };
      credential = reread;
      if (!credential.expiresAt || credential.expiresAt > refreshBefore) {
        outcome = { outcome: "current", credential };
        break;
      }
      if (credential.expiresAt.getTime() > now()) break;
      await (input.sleep ?? defaultSleep)(REFRESH_LOCK_RETRY_MS);
      outcome = await attempt();
    }
    if (outcome.outcome === "missing") return { kind: "missing" };
    if (outcome.outcome === "refreshed" || outcome.outcome === "current") {
      credential = outcome.credential;
      refreshed = outcome.outcome === "refreshed";
    } else if (outcome.outcome === "failed") {
      credential = outcome.credential;
      if (credential.expiresAt && credential.expiresAt.getTime() <= now()) {
        return { kind: "refresh_failed" };
      }
    }
  }
  if (credential.expiresAt && credential.expiresAt.getTime() <= now()) return { kind: "expired" };
  let material: string;
  try {
    material = decryptEnvironmentValue(key, credential.materialEncrypted);
  } catch {
    return { kind: "error" };
  }
  const headers = endUserLoginHeaders(material);
  if (!headers || Object.keys(headers).length === 0) return { kind: "missing" };
  return { kind: "ok", headers, credentialId: credential.id, refreshed };
}

/**
 * OAuth refresh_token grant against the tool server's token endpoint. Returns
 * the new encrypted material and expiry, or null when the provider refused.
 */
async function refreshOAuthLogin(
  input: OrgAgentToolLoginsInput,
  toolServer: OrgToolServerRuntime,
  encryptionKey: Uint8Array,
  current: EndUserToolCredentialRow,
  now: () => number,
): Promise<{ materialEncrypted: string; expiresAt: Date | null } | null> {
  const refresh = toolServer.oauthRefresh;
  if (!refresh) return null;
  const material = JSON.parse(
    decryptEnvironmentValue(encryptionKey, current.materialEncrypted),
  ) as Record<string, unknown>;
  const refreshToken = material["refreshToken"];
  if (material["kind"] !== "oauth" || typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: refresh.clientId,
  });
  if (refresh.clientSecretEncrypted) {
    body.set(
      "client_secret",
      decryptEnvironmentValue(encryptionKey, refresh.clientSecretEncrypted),
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    };
    const response = input.fetchImpl
      ? await input.fetchImpl(refresh.tokenUrl, init)
      : await pinnedFetch(refresh.tokenUrl, init, input.settings, {
          label: "Organization tool server login refresh",
          requireHttpsOutsideLocalTest: true,
        });
    if (!response.ok) return null;
    const token = (await response.json()) as Record<string, unknown>;
    const accessToken = token["access_token"];
    if (typeof accessToken !== "string" || !accessToken) return null;
    const expiresIn = Number(token["expires_in"]);
    const next = {
      kind: "oauth" as const,
      accessToken,
      refreshToken:
        typeof token["refresh_token"] === "string" && token["refresh_token"]
          ? token["refresh_token"]
          : refreshToken,
      tokenType:
        typeof token["token_type"] === "string" && token["token_type"]
          ? token["token_type"]
          : typeof material["tokenType"] === "string"
            ? material["tokenType"]
            : "Bearer",
    };
    return {
      materialEncrypted: encryptEnvironmentValue(encryptionKey, JSON.stringify(next)),
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now() + expiresIn * 1000) : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
