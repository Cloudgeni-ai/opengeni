import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_SCOPES,
  ClaudeOAuthTokenResponse,
  ClaudeSubscriptionCredential,
  environmentsEncryptionKeyBytes,
  type Settings,
} from "@opengeni/config";
import { and, eq, sql } from "drizzle-orm";
import { readResponseJsonBounded } from "@opengeni/network";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import { encryptEnvironmentValue } from "./environment-crypto";
import { connections, organizationModelProviderConnections } from "./schema";
import {
  loadClaudeSubscriptionUsageCredential,
  recordClaudeSubscriptionUsage,
  type ClaudeUsageScope,
} from "./claude-subscription-usage";

export class ClaudeSubscriptionReconnectRequired extends Error {
  readonly status = 401;
  constructor() {
    super("Claude sign-in expired or was revoked. Sign in again in Models.");
  }
}
export class ClaudeSubscriptionRefreshUnavailable extends Error {
  readonly status = 503;
  constructor() {
    super("Couldn't renew Claude sign-in. Try again.");
  }
}
export class ClaudeSubscriptionConnectionChanged extends Error {
  readonly status = 409;
  constructor() {
    super("Claude connection changed; reload usage.");
  }
}

export async function requestClaudeTokenRefresh(
  bundle: import("zod").z.infer<typeof ClaudeSubscriptionCredential>,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  if (!bundle.oauth) throw new ClaudeSubscriptionReconnectRequired();
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: bundle.oauth!.refreshToken,
        scope: bundle.oauth!.scopes.join(" "),
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 400) {
        const body = await readResponseJsonBounded<unknown>(response, 16 * 1024, "Claude refresh", {
          signal,
        }).catch(() => null);
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        if (response.status === 401 || error === "invalid_grant")
          throw new ClaudeSubscriptionReconnectRequired();
      } else await response.body?.cancel().catch(() => undefined);
      throw new ClaudeSubscriptionRefreshUnavailable();
    }
    const tokens = ClaudeOAuthTokenResponse.parse(
      await readResponseJsonBounded(response, 64 * 1024, "Claude refresh", {
        signal,
      }),
    );
    if (!CLAUDE_OAUTH_SCOPES.every((required) => tokens.scope.split(/\s+/).includes(required)))
      throw new ClaudeSubscriptionReconnectRequired();
    return tokens;
  } catch (error) {
    if (error instanceof ClaudeSubscriptionReconnectRequired) throw error;
    throw new ClaudeSubscriptionRefreshUnavailable();
  }
}

/** The existing connection generation remains authority; token renewal is not replacement. */
export async function resolveClaudeSubscriptionCredential(
  db: Database,
  settings: Settings,
  scope: ClaudeUsageScope,
  options: {
    expectedConnectionId?: string;
    expectedCredentialVersion?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
) {
  if (!settings.claudeSubscriptionEnabled) return null;
  const now = options.now ?? Date.now;
  const matches = (credential: Awaited<ReturnType<typeof loadClaudeSubscriptionUsageCredential>>) =>
    credential &&
    (!options.expectedConnectionId || credential.connectionId === options.expectedConnectionId) &&
    (options.expectedCredentialVersion === undefined ||
      credential.credentialVersion === options.expectedCredentialVersion);
  const original = await loadClaudeSubscriptionUsageCredential(db, settings, scope);
  if (!matches(original)) return null;
  const parse = (value: string) =>
    value.startsWith("{") ? ClaudeSubscriptionCredential.parse(JSON.parse(value)) : null;
  const bundle = parse(original!.serializedCredential);
  if (!bundle?.oauth || Date.parse(bundle.oauth.expiresAt) - now() > 60_000) return original;
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("Claude credential encryption is unavailable");
  return withRlsContext(db, scope, async (tx) => {
    if (scope.scope === "organization" && scope.workspaceId === null) {
      if (!scope.actorSubjectId) throw new Error("Claude organization administrator is required");
      await setSubjectRlsContext(tx, scope.actorSubjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${scope.accountId}::uuid, ${scope.actorSubjectId})`,
      );
    }
    // Same pattern as the Codex resolver: replicas serialize and then re-read.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"claude-token:" + original!.connectionId}, 0))`,
    );
    const current = await loadClaudeSubscriptionUsageCredential(tx, settings, scope);
    if (
      !matches(current) ||
      current!.connectionId !== original!.connectionId ||
      current!.credentialVersion !== original!.credentialVersion
    )
      return null;
    const latest = parse(current!.serializedCredential);
    if (!latest?.oauth || Date.parse(latest.oauth.expiresAt) - now() > 60_000) return current;
    let tokens: ReturnType<typeof ClaudeOAuthTokenResponse.parse>;
    try {
      tokens = await requestClaudeTokenRefresh(latest, options.fetchImpl ?? globalThis.fetch);
    } catch (error) {
      if (error instanceof ClaudeSubscriptionReconnectRequired) {
        const usage = await recordClaudeSubscriptionUsage(tx, settings, scope, {
          token: current!.token,
          expectedConnectionId: current!.connectionId,
          expectedCredentialVersion: current!.credentialVersion,
          refresh: {
            status: "reconnect",
            checkedAt: new Date(now()).toISOString(),
          },
        });
        // Commit the truthful status before the caller raises its reconnect error.
        if (!usage) throw new ClaudeSubscriptionConnectionChanged();
        return { ...current!, usage, reconnectRequired: true as const };
      }
      throw new ClaudeSubscriptionRefreshUnavailable();
    }
    const refreshed = ClaudeSubscriptionCredential.parse({
      ...latest,
      token: tokens.access_token,
      oauth: {
        ...latest.oauth,
        refreshToken: tokens.refresh_token ?? latest.oauth.refreshToken,
        expiresAt: new Date(now() + tokens.expires_in * 1000).toISOString(),
        scopes: tokens.scope.split(/\s+/).filter(Boolean),
      },
    });
    const serialized = JSON.stringify(refreshed);
    const table = scope.scope === "workspace" ? connections : organizationModelProviderConnections;
    const encrypted = encryptEnvironmentValue(
      key,
      scope.scope === "workspace" ? JSON.stringify({ apiKey: serialized }) : serialized,
    );
    const rows = await tx
      .update(table)
      .set({ credentialEncrypted: encrypted })
      .where(
        and(
          eq(table.id, current!.connectionId),
          eq(table.accountId, scope.accountId),
          eq(table.version, current!.credentialVersion),
          eq(table.status, "active"),
          eq(table.credentialEncrypted, current!.credentialEncrypted),
        ),
      )
      .returning({ id: table.id });
    if (!rows.length) throw new ClaudeSubscriptionConnectionChanged();
    return {
      ...current!,
      token: refreshed.token,
      serializedCredential: serialized,
      credentialEncrypted: encrypted,
    };
  });
}
