import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
} from "@opengeni/contracts";
import { requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  consumeIntegrationOAuthPendingState,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getOrganizationModelProviderConnection,
  getWorkspaceProviderApiKeyConnectionMetadata,
  loadIntegrationOAuthPendingState,
  storeIntegrationOAuthPendingState,
  upsertOrganizationModelProviderConnection,
  organizationModelProviderCredentialDigest,
  upsertWorkspaceProviderApiKeyConnection,
  rotateWorkspaceProviderApiKeyConnection,
  loadClaudeSubscriptionUsageCredential,
  withRlsContext,
  OrganizationModelProviderConflictError,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prepareClaudeSubscriptionCredential } from "./claude-workspace-connection";
import { refreshClaudeSubscriptionUsage } from "./claude-subscription-usage";

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
    connectionId: z.string().uuid().nullable(),
    credentialVersion: z.number().int().nonnegative(),
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

export async function startClaudeSubscriptionOAuth(deps: ApiRouteDeps, scope: ClaudeOAuthScope) {
  const key = requireEnvironmentEncryption(deps.settings);
  const current = scope.workspaceId
    ? await getWorkspaceProviderApiKeyConnectionMetadata(
        deps.db,
        scope.workspaceId,
        "claude_subscription",
      )
    : await getOrganizationModelProviderConnection(deps.db, {
        organizationId: scope.accountId,
        actorSubjectId: scope.actorSubjectId,
        providerKind: "claude_subscription",
      });
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const id = randomUUID(),
    expiresAt = new Date(Date.now() + 10 * 60_000);
  const attempt = Attempt.parse({
    stage: "pending",
    purpose: "claude-subscription-oauth",
    ...scope,
    state,
    verifier,
    connectionId: current && "connectionId" in current ? current.connectionId : null,
    credentialVersion: current?.version ?? 0,
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

/** Native encrypted connection writers own replacement, access policy and CAS. */
export async function completeClaudeSubscriptionOAuth(
  deps: ApiRouteDeps,
  scope: ClaudeOAuthScope,
  input: { attemptId: string; code: string },
  reauthorize: () => Promise<void>,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const key = requireEnvironmentEncryption(deps.settings);
  const encrypted = await loadIntegrationOAuthPendingState(deps.db, {
    ...scope,
    id: input.attemptId,
  });
  if (!encrypted)
    throw new HTTPException(410, {
      message: "Claude sign-in expired or was already used. Start again.",
    });
  const parsed = (() => {
    try {
      return Attempt.safeParse(JSON.parse(decryptEnvironmentValue(key, encrypted)));
    } catch {
      return { success: false as const };
    }
  })();
  if (!parsed.success)
    throw new HTTPException(410, {
      message: "Claude sign-in expired. Start again.",
    });
  const attempt = parsed.data;
  if (
    attempt.accountId !== scope.accountId ||
    attempt.workspaceId !== scope.workspaceId ||
    attempt.actorSubjectId !== scope.actorSubjectId ||
    !same(attempt.browserSessionHash, scope.browserSessionHash)
  ) {
    throw new HTTPException(403, {
      message: "Complete Claude sign-in in the browser where you started it.",
    });
  }
  if (attempt.stage === "complete") {
    const current = await loadClaudeSubscriptionUsageCredential(deps.db, deps.settings, {
      ...scope,
      scope: scope.workspaceId ? "workspace" : "organization",
    });
    if (
      !current ||
      current.connectionId !== attempt.connectionId ||
      current.credentialVersion !== attempt.credentialVersion
    )
      throw new HTTPException(409, {
        message: "Claude connection changed. Start sign-in again.",
      });
    return ClaudeSubscriptionOAuthCompleteResponse.parse({
      connected: true,
      credentialVersion: attempt.credentialVersion,
    });
  }
  const parts = input.code.trim().split("#");
  if (parts.length !== 2 || !parts[0] || !same(parts[1]!, attempt.state))
    throw new HTTPException(422, {
      message: "Copy the full authorization code from the Claude page.",
    });
  // Reject a connection change before spending the one-use authorization code.
  const current = scope.workspaceId
    ? await getWorkspaceProviderApiKeyConnectionMetadata(
        deps.db,
        scope.workspaceId,
        "claude_subscription",
      )
    : await getOrganizationModelProviderConnection(deps.db, {
        organizationId: scope.accountId,
        actorSubjectId: scope.actorSubjectId,
        providerKind: "claude_subscription",
      });
  if (
    (current?.version ?? 0) !== attempt.credentialVersion ||
    (scope.workspaceId &&
      (current && "connectionId" in current ? current.connectionId : null) !== attempt.connectionId)
  )
    throw new HTTPException(409, {
      message: "Claude connection changed. Start sign-in again.",
    });
  const consumed = await consumeIntegrationOAuthPendingState(deps.db, {
    ...scope,
    id: input.attemptId,
    stateEncrypted: encrypted,
  });
  if (!consumed)
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
      await readResponseJsonBounded(response, 64 * 1024, "Claude sign-in", {
        signal,
      }),
    );
    const granted = tokens.scope.split(/\s+/).filter(Boolean);
    if (!CLAUDE_OAUTH_SCOPES.every((required) => granted.includes(required)))
      throw new Error("Required scopes missing");
  } catch {
    // An exchanged code is never blindly retried after an uncertain response.
    throw new HTTPException(502, {
      message: "Claude sign-in could not be completed. Start sign-in again.",
    });
  }
  await reauthorize();
  const bundle = ClaudeSubscriptionCredential.parse({
    ...JSON.parse(
      prepareClaudeSubscriptionCredential(
        deps.settings,
        scope.workspaceId ? "workspace:" + scope.workspaceId : "organization:" + scope.accountId,
        tokens.access_token,
      ),
    ),
    oauth: {
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
    },
  });
  if (tokens.account) bundle.identity.accountUuid = tokens.account.uuid;
  const serialized = JSON.stringify(bundle);
  const version = await withRlsContext(deps.db, scope, async (tx) => {
    let version: number;
    if (scope.workspaceId) {
      const connectionInput = {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        operationId: input.attemptId,
        requestDigest: createHash("sha256").update(serialized).digest("hex"),
        credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ apiKey: serialized })),
        metadata: {
          credentialRole: "claude_subscription",
          credentialLabel: "Claude subscription",
        },
        updatedBySubjectId: scope.actorSubjectId,
      };
      const saved = attempt.connectionId
        ? await rotateWorkspaceProviderApiKeyConnection(tx, "claude_subscription", {
            ...connectionInput,
            connectionId: attempt.connectionId,
            expectedVersion: attempt.credentialVersion,
          })
        : await upsertWorkspaceProviderApiKeyConnection(tx, "claude_subscription", connectionInput);
      if (!saved)
        throw new HTTPException(409, {
          message: "Claude connection changed. Start sign-in again.",
        });
      version = saved.version;
    } else {
      const saved = await upsertOrganizationModelProviderConnection(tx, {
        organizationId: scope.accountId,
        actorSubjectId: scope.actorSubjectId,
        providerKind: "claude_subscription",
        operationId: input.attemptId,
        expectedVersion: attempt.credentialVersion,
        credentialEncrypted: encryptEnvironmentValue(key, serialized),
        credentialDigest: organizationModelProviderCredentialDigest(serialized),
      });
      version = saved.version;
    }
    const savedCredential = await loadClaudeSubscriptionUsageCredential(tx, deps.settings, {
      ...scope,
      scope: scope.workspaceId ? "workspace" : "organization",
    });
    if (
      !savedCredential ||
      savedCredential.credentialVersion !== version ||
      savedCredential.token !== tokens.access_token
    )
      throw new HTTPException(409, {
        message: "Claude connection changed. Start sign-in again.",
      });
    // Secret-free replay evidence commits atomically with the new credential.
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
          connectionId: savedCredential.connectionId,
          credentialVersion: version,
        }),
      ),
    });
    return version;
  }).catch((error) => {
    if (error instanceof OrganizationModelProviderConflictError)
      throw new HTTPException(409, {
        message: "Claude connection changed. Start sign-in again.",
      });
    throw error;
  });
  // The first quota read is read-only provider traffic, never an inference call.
  await refreshClaudeSubscriptionUsage(
    deps.db,
    deps.settings,
    {
      ...scope,
      scope: scope.workspaceId ? "workspace" : "organization",
    },
    fetchImpl,
  ).catch(() => undefined);
  return ClaudeSubscriptionOAuthCompleteResponse.parse({
    connected: true,
    credentialVersion: version,
  });
}
