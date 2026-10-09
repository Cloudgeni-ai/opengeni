import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  CODEX_CLIENT_VERSION,
  CODEX_WHAM_BASE,
  CodexReloginRequired,
  codexSubscriptionHeaders,
  normalizeCodexUsage,
  refreshCodexToken,
  type CodexFetch,
  type CodexAuthHeaders,
  type CodexUsagePayload,
} from "@opengeni/codex";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import { buildCodexTokenResolver, type CodexAuthDeps } from "./codex-token-resolver";
import { readCodexCutoverDisposition } from "./subscription-core-codex-compat";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";

type AdministratorScope = <T>(db: Database, use: (tx: Database) => Promise<T>) => Promise<T>;

const nativeUsageFetch: CodexFetch = fetch;
const CORE_USAGE_TIMEOUT_MS = 5_000;
const CORE_USAGE_MAX_BYTES = 1024 * 1024;

function remainingCoreUsageBudget(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Codex usage request deadline exceeded");
  return remaining;
}

/**
 * An injected core transport must cancel and join its local work for this exact
 * signal, including any deferred dispatch, before this promise resolves. Native
 * Fetch already provides abortable fetch/body custody. Arbitrary CodexFetch
 * callbacks do not, so they fail closed before receiving a bearer.
 */
export type OrganizationCodexUsageJoinedFetch = CodexFetch & {
  abortAndJoin: (signal: AbortSignal) => Promise<void>;
};

function joinedTransport(fetchImpl: CodexFetch) {
  if (fetchImpl === nativeUsageFetch) return null;
  const candidate = fetchImpl as Partial<OrganizationCodexUsageJoinedFetch>;
  if (typeof candidate.abortAndJoin !== "function") {
    throw new Error("Organization Codex usage requires an abort-and-join transport");
  }
  return candidate.abortAndJoin.bind(fetchImpl);
}

/** No detached deadline: the administrator transaction awaits local fetch/body teardown. */
async function fetchCoreUsageJoined(
  auth: CodexAuthHeaders,
  fetchImpl: CodexFetch,
  options: { signal?: AbortSignal; deadline: number },
): Promise<{ status: number; payload: unknown }> {
  const abortAndJoin = joinedTransport(fetchImpl);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let teardown: Promise<unknown> = Promise.resolve();
  const abort = () => controller.abort(new Error("Codex usage request aborted"));
  const onAbort = () => {
    teardown = Promise.all([
      reader?.cancel().catch(() => undefined),
      Promise.resolve().then(() => abortAndJoin?.(controller.signal)),
    ]);
    // Observe immediately; the transaction still joins this exact promise below.
    void teardown.catch(() => undefined);
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  try {
    timer = setTimeout(abort, remainingCoreUsageBudget(options.deadline));
    controller.signal.throwIfAborted();
    // No await between this final expiry check and the physical invocation.
    remainingCoreUsageBudget(options.deadline);
    const response = await fetchImpl(`${CODEX_WHAM_BASE}/wham/usage`, {
      method: "GET",
      headers: codexSubscriptionHeaders(auth),
      redirect: "error",
      signal: controller.signal,
    });
    reader = response.body?.getReader();
    controller.signal.throwIfAborted();
    remainingCoreUsageBudget(options.deadline);
    if (Number(response.headers.get("content-length")) > CORE_USAGE_MAX_BYTES) {
      throw new Error("Codex usage response exceeded its byte limit");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        controller.signal.throwIfAborted();
        remainingCoreUsageBudget(options.deadline);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > CORE_USAGE_MAX_BYTES)
          throw new Error("Codex usage response exceeded its byte limit");
        if (response.ok || response.status === 404) chunks.push(next.value);
      }
    }
    let payload: unknown = null;
    if (response.ok || response.status === 404) {
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Preserve the existing usage normalization for invalid JSON, not body failures.
      }
    }
    remainingCoreUsageBudget(options.deadline);
    complete = true;
    return { status: response.status, payload };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!complete) abort();
    // A fetch that returns late after abort still has a body to cancel locally.
    if (controller.signal.aborted) await reader?.cancel().catch(() => undefined);
    await teardown;
    reader?.releaseLock();
  }
}

/**
 * Administrative usage inspection is independent of inference eligibility.
 * This path may refresh the exact account's bearer, but never changes quota,
 * allocation, model exclusions, credit consent, or workspace assignments.
 */
export async function readOrganizationCodexUsage(
  db: Database,
  settings: Settings,
  input: {
    organizationId: string;
    credentialId: string;
    mode: "core";
    signal?: AbortSignal;
    /** May shorten, never extend, the core admission-plus-request budget. */
    requestTimeoutMs?: number;
  },
  withAdministrator: AdministratorScope,
  fetchImpl: CodexFetch = fetch,
  refresh: CodexAuthDeps["refresh"] = refreshCodexToken,
): Promise<CodexUsagePayload> {
  let credentialId = input.credentialId;
  const condition = () =>
    sql`account_id = ${input.organizationId}::uuid and id = ${credentialId}::uuid
        and provider = 'codex' and kind = 'subscription' and ownership = 'shared'
        and managed_by_workspace_id is null and disconnected_at is null`;
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
      input.signal?.throwIfAborted();
      joinedTransport(fetchImpl);
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
    {
      const probe = (expectedGeneration: number) => {
        // Anchor before administrator/source-lock admission, not after its last
        // awaited credential read. A suspended worker may outlive PostgreSQL's
        // orphan-transaction backstop; resuming it must not restart this budget.
        const timeoutMs = Number.isFinite(input.requestTimeoutMs)
          ? Math.min(CORE_USAGE_TIMEOUT_MS, Math.max(1, input.requestTimeoutMs!))
          : CORE_USAGE_TIMEOUT_MS;
        const deadline = performance.now() + timeoutMs;
        return scoped(db, async (tx) => {
          remainingCoreUsageBudget(deadline);
          // The read-only exception holds the source lock through the finite GET.
          // A dead worker cannot leave an idle transaction retaining this lock.
          await tx.execute(sql`set local idle_in_transaction_session_timeout = '10s'`);
          remainingCoreUsageBudget(deadline);
          await tx.execute(sql`set local statement_timeout = '10s'`);
          remainingCoreUsageBudget(deadline);
          await tx.execute(sql`set local lock_timeout = '5s'`);
          remainingCoreUsageBudget(deadline);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-refresh:${credentialId}`}, 0))`,
          );
          remainingCoreUsageBudget(deadline);
          // Re-enter native administration/cutover checks AFTER the source lock.
          // Never send the resolver's previously cached bearer or return this one.
          const current = await deps.loadCredential(
            tx,
            settings,
            input.organizationId,
            credentialId,
          );
          remainingCoreUsageBudget(deadline);
          if (!current) throw new CodexReloginRequired("Sign in to ChatGPT again");
          if (current.version !== expectedGeneration) return null;
          return await fetchCoreUsageJoined(
            {
              accessToken: current.tokens.accessToken,
              chatgptAccountId: current.chatgptAccountId,
              isFedramp: current.isFedramp,
              clientVersion: CODEX_CLIENT_VERSION,
            },
            fetchImpl,
            {
              deadline,
              ...(input.signal ? { signal: input.signal } : {}),
            },
          );
        });
      };
      let generation = (await resolver.getToken()).credentialVersion;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let result = await probe(generation);
        if (!result) {
          generation = (await resolver.getToken()).credentialVersion;
          result = await probe(generation);
          if (!result) throw new Error("Codex account changed while checking usage");
        }
        if (result.status !== 401) return normalizeCodexUsage(result.status, result.payload);
        if (attempt === 1) {
          const marked = await deps.setStatus(db, input.organizationId, "needs_relogin", null, {
            id: credentialId,
            version: generation,
          });
          if (marked) throw new CodexReloginRequired("Sign in to ChatGPT again");
          throw new Error("Codex account changed while checking usage");
        }
        const latest = await deps.loadCredential(db, settings, input.organizationId, credentialId);
        if (!latest) throw new CodexReloginRequired("Sign in to ChatGPT again");
        generation = (
          latest.version !== generation ? await resolver.getToken() : await resolver.refresh()
        ).credentialVersion;
      }
      throw new Error("Codex usage retry exhausted");
    }
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
