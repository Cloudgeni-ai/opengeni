import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  CODEX_CLIENT_VERSION,
  CodexReloginRequired,
  fetchCodexUsage,
  normalizeCodexUsage,
  refreshCodexToken,
  type CodexFetch,
  type CodexUsagePayload,
} from "@opengeni/codex";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import { buildCodexTokenResolver, type CodexAuthDeps } from "./codex-token-resolver";
import { readCodexCutoverDisposition } from "./subscription-core-codex-compat";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";

type AdministratorScope = <T>(db: Database, use: (tx: Database) => Promise<T>) => Promise<T>;

/**
 * Administrative usage inspection is independent of inference eligibility.
 * This path may refresh the exact account's bearer, but never changes quota,
 * allocation, model exclusions, credit consent, or workspace assignments.
 */
export async function readOrganizationCodexUsage(
  db: Database,
  settings: Settings,
  input: { organizationId: string; credentialId: string; mode: "core" },
  withAdministrator: AdministratorScope,
  fetchImpl: CodexFetch = fetch,
  refresh: CodexAuthDeps["refresh"] = refreshCodexToken,
): Promise<CodexUsagePayload> {
  let credentialId = input.credentialId;
  const condition = () =>
    sql`account_id = ${input.organizationId}::uuid and id = ${credentialId}::uuid
        and provider = 'codex' and kind = 'subscription' and ownership = 'shared'
        and managed_by_workspace_id is null`;
  const scoped: AdministratorScope = (targetDb, use) =>
    withAdministrator(targetDb, async (tx) => {
      if ((await readCodexCutoverDisposition(tx, input.organizationId)) !== "core") {
        throw new Error("Codex usage is unavailable during subscription maintenance");
      }
      return await use(tx);
    });
  const deps: CodexAuthDeps = {
    refreshKeyScope: `organization-usage:${input.organizationId}`,
    refresh,
    encrypt: encryptEnvironmentValue,
    keyBytes: environmentsEncryptionKeyBytes,
    loadCredential: (targetDb) =>
      scoped(targetDb, async (tx) => {
        const rows = await rawRows<Record<string, unknown>>(
          tx,
          sql`
          select id, refresh_generation as version, credential_encrypted, status, last_error,
            expires_at, last_refresh_at, plan_type,
            provider_account_id,
            coalesce((provider_state->>'isFedramp')::boolean, false) as is_fedramp
          from subscription_connections where ${condition()}
        `,
        );
        const row = rows[0];
        if (!row || row.status !== "active") return null;
        const key = environmentsEncryptionKeyBytes(settings);
        if (!key) throw new Error("Codex credential encryption is not configured");
        let tokens;
        try {
          const stored = JSON.parse(decryptEnvironmentValue(key, String(row.credential_encrypted)));
          if (
            ![stored.access_token, stored.refresh_token, stored.id_token].every(
              (v) => typeof v === "string",
            )
          ) {
            throw new Error("Invalid credential");
          }
          tokens = {
            accessToken: stored.access_token,
            refreshToken: stored.refresh_token,
            idToken: stored.id_token,
          };
        } catch {
          throw new Error("Could not read the Codex credential");
        }
        return {
          id: String(row.id),
          version: Number(row.version),
          workspaceId: input.organizationId,
          tokens,
          chatgptAccountId: row.provider_account_id as string | null,
          scopes: null,
          planType: row.plan_type as string | null,
          isFedramp: row.is_fedramp === true,
          expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
          lastRefreshAt: row.last_refresh_at ? new Date(String(row.last_refresh_at)) : null,
          status: String(row.status),
          lastError: row.last_error as string | null,
          exhaustedUntil: null,
          exhaustedKind: null,
          exhaustedRevision: 0,
        };
      }),
    withRefreshLock: (targetDb, _scope, refreshCredentialId, use) =>
      scoped(targetDb, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '30s'`);
        const key = `subscription-refresh:${refreshCredentialId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        return await use(tx);
      }),
    // OAuth can rotate a one-use refresh token. Once admitted under the refresh
    // lock, retain its outcome even if maintenance or quarantine starts during
    // the provider call. Generation CAS still fences a replacement credential;
    // fresh authority/health checks below decide whether usage may be fetched.
    recordRefresh: (targetDb, next) =>
      withAdministrator(targetDb, async (tx) => {
        const rows = await rawRows<Record<string, unknown>>(
          tx,
          sql`
          update subscription_connections set credential_encrypted = ${next.credentialEncrypted},
            credential_format = split_part(${next.credentialEncrypted}, ':', 1),
            expires_at = ${next.expiresAt?.toISOString() ?? null}::timestamptz,
            last_refresh_at = ${next.lastRefreshAt.toISOString()}::timestamptz,
            refresh_generation = refresh_generation + 1, updated_at = clock_timestamp()
          where ${condition()} and refresh_generation = ${next.version}
          returning id
        `,
        );
        return rows.length > 0;
      }),
    setStatus: (targetDb, _scope, status, _error, target) =>
      scoped(targetDb, async (tx) => {
        const rows = await rawRows<Record<string, unknown>>(
          tx,
          sql`
          update subscription_connections set status = ${status},
            last_error = 'Sign in to ChatGPT again', updated_at = clock_timestamp()
          where ${condition()} and refresh_generation = ${target.version} and status = 'active'
          returning id
        `,
        );
        return rows.length > 0;
      }),
  };
  try {
    {
      // Resolve under current administrator authority, then freeze this exact
      // identity for reads, refresh locking and generation-fenced writes.
      const canonical = await scoped(db, (tx) =>
        resolveSubscriptionConnectionId(tx, {
          accountId: input.organizationId,
          provider: "codex",
          connectionId: input.credentialId,
        }),
      );
      if (!canonical) throw new CodexReloginRequired("Sign in to ChatGPT again");
      credentialId = canonical;
    }
    const resolver = buildCodexTokenResolver(
      db,
      settings,
      input.organizationId,
      credentialId,
      deps,
    );
    let token = await resolver.getToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Recheck administration, maintenance and health before each dispatch.
      let current = await deps.loadCredential(db, settings, input.organizationId, credentialId);
      if (!current) throw new CodexReloginRequired("Sign in to ChatGPT again");
      if (current.version !== token.credentialVersion) {
        token = await resolver.getToken();
        current = await deps.loadCredential(db, settings, input.organizationId, credentialId);
        if (!current || current.version !== token.credentialVersion) {
          throw new Error("Codex account changed while checking usage");
        }
      }
      const result = await fetchCodexUsage(
        { ...token, clientVersion: CODEX_CLIENT_VERSION },
        fetchImpl,
      );
      if (result.status !== 401) return normalizeCodexUsage(result.status, result.payload);
      if (attempt === 1) {
        const marked = await deps.setStatus(db, input.organizationId, "needs_relogin", null, {
          id: credentialId,
          version: token.credentialVersion,
        });
        if (marked) throw new CodexReloginRequired("Sign in to ChatGPT again");
        throw new Error("Codex account changed while checking usage");
      }
      const latest = await deps.loadCredential(db, settings, input.organizationId, credentialId);
      if (!latest) throw new CodexReloginRequired("Sign in to ChatGPT again");
      // Another caller may already have replaced the rejected bearer.
      token =
        latest.version !== token.credentialVersion
          ? await resolver.getToken()
          : await resolver.refresh();
    }
    throw new Error("Codex usage retry exhausted");
  } catch (error) {
    return {
      status: "error",
      planType: null,
      fiveHour: null,
      weekly: null,
      limitReached: false,
      fetchedAt: new Date().toISOString(),
      rateLimitResetCredits: null,
      ...(error instanceof CodexReloginRequired ? { reason: "needs_relogin" as const } : {}),
    };
  }
}
