import { claudeAccountMutationFailure } from "./claude-subscription-account-conflicts";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_SCOPES,
  ClaudeOAuthTokenResponse,
  ClaudeSubscriptionCredential,
  claudeAuthorizationUrl,
} from "@opengeni/config";
import {
  ClaudeSubscriptionOAuthStartResponse,
  ClaudeSubscriptionOAuthCompleteResponse,
  ClaudeProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  consumeIntegrationOAuthPendingState,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  loadIntegrationOAuthPendingState,
  storeIntegrationOAuthPendingState,
  withRlsContext,
  getClaudeSubscriptionAccountAuthoritySnapshot,
  getClaudeSubscriptionAccountMetadata,
  listOrganizationClaudeSubscriptions,
  upsertOrganizationClaudeSubscription,
  upsertClaudeSubscriptionAccount,
  setInitialActiveClaudeCredential,
  wakeClaudeCapacityWaiters,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prepareClaudeSubscriptionCredential } from "./claude-workspace-connection";
import {
  fetchClaudeSubscriptionProfile,
  parseClaudeSubscriptionProfile,
} from "./claude-subscription-profile";

export type ClaudeOAuthScope = {
  accountId: string;
  workspaceId: string | null;
  actorSubjectId: string;
  browserSessionHash: string;
};
const AttemptScope = z
  .object({
    purpose: z.literal("claude-subscription-oauth"),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid().nullable(),
    actorSubjectId: z.string().min(1),
    browserSessionHash: z.string().min(1),
    poolScope: z.enum(["organization", "workspace", "user"]),
    credentialId: z.string().uuid().nullable(),
    credentialVersion: z.number().int().nonnegative(),
    authoritySnapshot: ClaudeProviderAccountAuthoritySnapshotV1.nullable(),
  })
  .strict();
const Attempt = z.discriminatedUnion("stage", [
  AttemptScope.extend({
    stage: z.literal("pending"),
    state: z.string().min(32).max(128),
    verifier: z.string().min(32).max(128),
  }),
  AttemptScope.extend({ stage: z.literal("complete") }),
]);
const Tokens = ClaudeOAuthTokenResponse.extend({
  refresh_token: z.string().min(1).max(16384),
  account: z.object({ uuid: z.string().uuid() }).passthrough().optional(),
}).passthrough();
function same(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const changed = () =>
  new HTTPException(409, { message: "Claude account changed during sign-in. Start again." });
async function target(deps: ApiRouteDeps, scope: ClaudeOAuthScope, credentialId: string) {
  if (!scope.workspaceId) {
    const pool = await listOrganizationClaudeSubscriptions(deps.db, {
      organizationId: scope.accountId,
      actorSubjectId: scope.actorSubjectId,
    });
    const account = pool.accounts.find((account) => account.id === credentialId);
    return account
      ? { account, authoritySnapshot: { version: 1, scope: "organization" } as const }
      : null;
  }
  const input = { workspaceId: scope.workspaceId, subjectId: scope.actorSubjectId, credentialId };
  const authoritySnapshot = await getClaudeSubscriptionAccountAuthoritySnapshot(deps.db, input);
  if (!authoritySnapshot) return null;
  const account = await getClaudeSubscriptionAccountMetadata(deps.db, input);
  return account ? { account, authoritySnapshot } : null;
}
export async function startClaudeSubscriptionOAuth(
  deps: ApiRouteDeps,
  scope: ClaudeOAuthScope,
  input: { scope?: "workspace" | "user" | undefined; reconnectAccountId?: string | undefined } = {},
) {
  const key = requireEnvironmentEncryption(deps.settings);
  const poolScope = scope.workspaceId ? (input.scope ?? "workspace") : "organization";
  const current = input.reconnectAccountId
    ? await target(deps, scope, input.reconnectAccountId)
    : null;
  if (input.reconnectAccountId && (!current || current.account.scope !== poolScope))
    throw changed();
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("base64url");
  const id = randomUUID(),
    expiresAt = new Date(Date.now() + 10 * 60_000);
  const attempt = Attempt.parse({
    stage: "pending",
    purpose: "claude-subscription-oauth",
    ...scope,
    poolScope,
    state,
    verifier,
    credentialId: current?.account.id ?? null,
    credentialVersion: current?.account.version ?? 0,
    authoritySnapshot: current?.authoritySnapshot ?? null,
  });
  await storeIntegrationOAuthPendingState(deps.db, {
    ...scope,
    id,
    expiresAt,
    stateEncrypted: encryptEnvironmentValue(key, JSON.stringify(attempt)),
  });
  return ClaudeSubscriptionOAuthStartResponse.parse({
    attemptId: id,
    expiresAt: expiresAt.toISOString(),
    authorizationUrl: claudeAuthorizationUrl({
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    }),
  });
}

/** Each attempt adds one account or reconnects one exact, generation-fenced target. */
export async function completeClaudeSubscriptionOAuth(
  deps: ApiRouteDeps,
  scope: ClaudeOAuthScope,
  input: { attemptId: string; code: string },
  reauthorize: (poolScope?: "workspace" | "user" | "organization") => Promise<void>,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const key = requireEnvironmentEncryption(deps.settings);
  const encrypted = await loadIntegrationOAuthPendingState(deps.db, {
    ...scope,
    id: input.attemptId,
  });
  const parsed = (() => {
    try {
      return Attempt.safeParse(JSON.parse(decryptEnvironmentValue(key, encrypted!)));
    } catch {
      return { success: false as const };
    }
  })();
  if (!parsed.success)
    throw new HTTPException(410, {
      message: "Claude sign-in expired or was already used. Start again.",
    });
  const attempt = parsed.data;
  if (
    attempt.accountId !== scope.accountId ||
    attempt.workspaceId !== scope.workspaceId ||
    attempt.actorSubjectId !== scope.actorSubjectId ||
    !same(attempt.browserSessionHash, scope.browserSessionHash)
  )
    throw new HTTPException(403, {
      message: "Complete Claude sign-in in the browser where you started it.",
    });
  await reauthorize(attempt.poolScope);
  const current = attempt.credentialId ? await target(deps, scope, attempt.credentialId) : null;
  if (
    attempt.credentialId &&
    (!current ||
      current.account.version !== attempt.credentialVersion ||
      current.account.scope !== attempt.poolScope ||
      JSON.stringify(current.authoritySnapshot) !== JSON.stringify(attempt.authoritySnapshot))
  )
    throw changed();
  if (attempt.stage === "complete")
    return ClaudeSubscriptionOAuthCompleteResponse.parse({
      connected: true,
      accountId: attempt.credentialId,
      scope: attempt.poolScope,
      credentialVersion: attempt.credentialVersion,
    });
  const parts = input.code.trim().split("#");
  if (parts.length !== 2 || !parts[0] || !same(parts[1]!, attempt.state))
    throw new HTTPException(422, {
      message: "Copy the full authorization code from the Claude page.",
    });
  if (
    !(await consumeIntegrationOAuthPendingState(deps.db, {
      ...scope,
      id: input.attemptId,
      stateEncrypted: encrypted!,
    }))
  )
    throw new HTTPException(410, {
      message: "Claude sign-in expired or was already used. Start again.",
    });
  let tokens: z.infer<typeof Tokens>;
  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URL,
        code: parts[0],
        code_verifier: attempt.verifier,
        state: attempt.state,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Token exchange refused");
    }
    tokens = Tokens.parse(
      await readResponseJsonBounded(response, 64 * 1024, "Claude sign-in", { signal }),
    );
    if (!CLAUDE_OAUTH_SCOPES.every((required) => tokens.scope.split(/\s+/).includes(required)))
      throw new Error("Required scopes missing");
  } catch {
    throw new HTTPException(502, {
      message: "Claude sign-in could not be completed. Start sign-in again.",
    });
  }
  const scopes = tokens.scope.split(/\s+/).filter(Boolean);
  const direct = parseClaudeSubscriptionProfile({
    account: tokens.account,
    organization: tokens.organization,
  });
  const profile = await fetchClaudeSubscriptionProfile(tokens.access_token, scopes, fetchImpl);
  if (tokens.account && profile && tokens.account.uuid !== profile.accountUuid)
    throw new HTTPException(502, {
      message: "Claude returned inconsistent account details. Start sign-in again.",
    });
  const accountUuid = tokens.account?.uuid ?? profile?.accountUuid ?? "";
  if (
    current?.account.providerAccountId &&
    !/^(setup|oauth):/.test(current.account.providerAccountId) &&
    current.account.providerAccountId !== accountUuid
  )
    throw new HTTPException(409, {
      message:
        "Sign in to the same Claude account to reconnect. Use Add account for a different subscription.",
    });
  await reauthorize(attempt.poolScope);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const bundle = ClaudeSubscriptionCredential.parse({
    ...JSON.parse(
      prepareClaudeSubscriptionCredential(
        deps.settings,
        scope.workspaceId ? "workspace:" + scope.workspaceId : "organization:" + scope.accountId,
        tokens.access_token,
      ),
    ),
    identity: {
      accountUuid,
      deviceId: createHmac("sha256", key)
        .update("claude-device:" + (scope.workspaceId ?? scope.accountId))
        .digest("hex"),
    },
    oauth: { refreshToken: tokens.refresh_token, expiresAt: expiresAt.toISOString(), scopes },
  });
  const providerAccountId =
    accountUuid || "oauth:" + createHmac("sha256", key).update(tokens.access_token).digest("hex");
  const details = {
    encryptionKey: key,
    secret: bundle,
    providerAccountId,
    accountEmail: profile?.email ?? direct?.email ?? null,
    planType: profile?.plan ?? direct?.plan ?? null,
    expiresAt,
    label: current?.account.label ?? null,
  };
  const saved = await withRlsContext(deps.db, scope, async (tx) => {
    const connected = scope.workspaceId
      ? await upsertClaudeSubscriptionAccount(tx, {
          ...details,
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          subjectId: scope.actorSubjectId,
          scope: attempt.poolScope as "workspace" | "user",
          ...(attempt.credentialId
            ? {
                credentialId: attempt.credentialId,
                expectedCredentialVersion: attempt.credentialVersion,
                expectedProviderAccountId: current!.account.providerAccountId,
                authoritySnapshot: attempt.authoritySnapshot!,
              }
            : {}),
        })
      : await upsertOrganizationClaudeSubscription(tx, {
          ...details,
          organizationId: scope.accountId,
          actorSubjectId: scope.actorSubjectId,
          ...(attempt.credentialId
            ? {
                credentialId: attempt.credentialId,
                expectedCredentialVersion: attempt.credentialVersion,
                expectedProviderAccountId: current!.account.providerAccountId,
              }
            : {}),
        });
    const authoritySnapshot =
      "authoritySnapshot" in connected
        ? connected.authoritySnapshot
        : ({ version: 1, scope: "organization" } as const);
    if (scope.workspaceId)
      await setInitialActiveClaudeCredential(tx, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        subjectId: scope.actorSubjectId,
        credentialId: connected.account.id,
        authoritySnapshot,
      });
    await storeIntegrationOAuthPendingState(tx, {
      ...scope,
      id: input.attemptId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      stateEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({
          purpose: "claude-subscription-oauth",
          ...scope,
          stage: "complete",
          poolScope: attempt.poolScope,
          credentialId: connected.account.id,
          credentialVersion: connected.account.version,
          authoritySnapshot,
        }),
      ),
    });
    return connected.account;
  }).catch(claudeAccountMutationFailure);
  if (scope.workspaceId)
    await wakeClaudeCapacityWaiters(deps.db, {
      workspaceId: scope.workspaceId,
      subjectId: scope.actorSubjectId,
      authoritySnapshot:
        attempt.poolScope === "workspace"
          ? { version: 1, scope: "workspace" }
          : (await target(deps, scope, saved.id))!.authoritySnapshot,
      reason: "claude_account_connected",
    });
  return ClaudeSubscriptionOAuthCompleteResponse.parse({
    connected: true,
    accountId: saved.id,
    scope: attempt.poolScope,
    credentialVersion: saved.version,
  });
}
