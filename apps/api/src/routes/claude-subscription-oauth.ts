import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ClaudeSubscriptionOAuthCompleteRequest,
  ClaudeSubscriptionOAuthStartResponse,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireFreshAccessGrant,
  requireEnvironmentEncryption,
  verifiedDelegatedHumanAuthorizationForRequest,
  type ApiRouteDeps,
} from "@opengeni/core";
import { claudeAuthorizationUrl } from "@opengeni/config";
import {
  consumeIntegrationOAuthPendingState,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getOrganizationModelProviderConnection,
  getWorkspaceProviderApiKeyConnectionMetadata,
  loadIntegrationOAuthPendingState,
  storeIntegrationOAuthPendingState,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { type Context, type Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hashCodexBrowserSession } from "../codex-redemption-security";
import {
  startClaudeSubscriptionOAuth,
  completeClaudeSubscriptionOAuth,
  type ClaudeOAuthScope,
} from "../claude-subscription-oauth";
import {
  managedCookieHuman,
  requireOrganizationCodexHuman,
  requireSameOriginBrowserMutation,
  DelegatedProviderActor,
  requireDelegatedProviderActor,
  requireMatchingDelegatedProviderActor,
  reauthorizeDelegatedProviderActor,
} from "./codex";

// Unlike native attempts, this carries NO browser session/hash. Only a native
// code-entry request by the exact person may adopt it into the browser helper.
const DelegatedClaudeAttempt = z
  .object({
    stage: z.literal("delegated_pending"),
    purpose: z.literal("claude-subscription-oauth"),
    delegatedActor: DelegatedProviderActor,
    state: z.string().min(32).max(128),
    authorizationBinding: z.string().min(32).max(4096),
    verifier: z.string().min(32).max(128),
    expiresAt: z.number().int().positive(),
    connectionId: z.string().uuid().nullable(),
    credentialVersion: z.number().int().nonnegative(),
  })
  .strict();

async function startDelegatedClaudeOAuth(c: Context, deps: ApiRouteDeps, organization: boolean) {
  c.header("cache-control", "private, no-store");
  if (!deps.settings.claudeSubscriptionEnabled)
    throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
  const id = z
    .string()
    .uuid()
    .safeParse(c.req.param(organization ? "organizationId" : "workspaceId"));
  if (!id.success) throw new HTTPException(404, { message: "Scope not found" });
  const delegatedActor = await requireDelegatedProviderActor(
    c,
    deps,
    "claude_subscription",
    organization ? { organizationId: id.data } : { workspaceId: id.data },
  );
  const key = requireEnvironmentEncryption(deps.settings);
  const current = organization
    ? await getOrganizationModelProviderConnection(deps.db, {
        organizationId: id.data,
        actorSubjectId: delegatedActor.subjectId,
        providerKind: "claude_subscription",
      })
    : await getWorkspaceProviderApiKeyConnectionMetadata(deps.db, id.data, "claude_subscription");
  const verifier = randomBytes(32).toString("base64url");
  const attemptId = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
  const state = randomBytes(32).toString("base64url");
  const authorizationBinding = createSignedState(deps.githubStateSecret, {
    purpose: "claude-subscription-oauth-delegated",
    attemptId,
    delegatedActor,
    state,
    expiresAt,
  });
  const attempt = DelegatedClaudeAttempt.parse({
    stage: "delegated_pending",
    purpose: "claude-subscription-oauth",
    delegatedActor,
    state,
    authorizationBinding,
    verifier,
    expiresAt,
    connectionId: current && "connectionId" in current ? current.connectionId : null,
    credentialVersion: current?.version ?? 0,
  });
  await reauthorizeDelegatedProviderActor(c, deps, delegatedActor);
  await storeIntegrationOAuthPendingState(deps.db, {
    id: attemptId,
    accountId: delegatedActor.organizationId,
    workspaceId: delegatedActor.workspaceId,
    actorSubjectId: delegatedActor.subjectId,
    expiresAt: new Date(expiresAt * 1000),
    stateEncrypted: encryptEnvironmentValue(key, JSON.stringify(attempt)),
  });
  return ClaudeSubscriptionOAuthStartResponse.parse({
    attemptId,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    authorizationUrl: claudeAuthorizationUrl({
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    }),
  });
}

async function adoptDelegatedClaudeAttempt(
  deps: ApiRouteDeps,
  nativeScope: ClaudeOAuthScope,
  input: { attemptId: string; code: string },
  reauthorize: () => Promise<void>,
) {
  const key = requireEnvironmentEncryption(deps.settings);
  const encrypted = await loadIntegrationOAuthPendingState(deps.db, {
    ...nativeScope,
    id: input.attemptId,
  });
  if (!encrypted) return; // The existing helper owns native expiry/replay errors.
  let raw: unknown;
  try {
    raw = JSON.parse(decryptEnvironmentValue(key, encrypted));
  } catch {
    return;
  }
  if (!raw || typeof raw !== "object" || !("stage" in raw) || raw.stage !== "delegated_pending")
    return;
  const parsed = DelegatedClaudeAttempt.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(410, { message: "Claude sign-in expired. Start again." });
  const attempt = parsed.data;
  requireMatchingDelegatedProviderActor(attempt.delegatedActor, {
    kind: "delegated_human",
    version: 1,
    provider: "claude_subscription",
    organizationId: nativeScope.accountId,
    workspaceId: nativeScope.workspaceId,
    subjectId: nativeScope.actorSubjectId,
  });
  const state = readSignedState(attempt.authorizationBinding, deps.githubStateSecret);
  if (
    !state ||
    state.purpose !== "claude-subscription-oauth-delegated" ||
    state.attemptId !== input.attemptId ||
    state.state !== attempt.state ||
    state.expiresAt !== attempt.expiresAt ||
    Date.now() / 1000 >= attempt.expiresAt
  )
    throw new HTTPException(410, { message: "Claude sign-in expired. Start again." });
  requireMatchingDelegatedProviderActor(state.delegatedActor, attempt.delegatedActor);
  const parts = input.code.trim().split("#");
  if (parts.length !== 2 || !parts[0] || parts[1] !== attempt.state)
    throw new HTTPException(422, {
      message: "Copy the full authorization code from the Claude page.",
    });
  await reauthorize();
  if (
    !(await consumeIntegrationOAuthPendingState(deps.db, {
      ...nativeScope,
      id: input.attemptId,
      stateEncrypted: encrypted,
    }))
  )
    throw new HTTPException(410, {
      message: "Claude sign-in expired or was already used. Start again.",
    });
  // This hash is obtained ONLY from the actual code-entry browser above. No
  // delegated request can stamp or recover native browser authority here.
  await storeIntegrationOAuthPendingState(deps.db, {
    ...nativeScope,
    id: input.attemptId,
    expiresAt: new Date(attempt.expiresAt * 1000),
    stateEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        stage: "pending",
        purpose: "claude-subscription-oauth",
        ...nativeScope,
        state: attempt.state,
        verifier: attempt.verifier,
        connectionId: attempt.connectionId,
        credentialVersion: attempt.credentialVersion,
      }),
    ),
  });
}

export function registerClaudeSubscriptionOAuthRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  async function scope(
    c: Context,
    organization: boolean,
    fresh = false,
  ): Promise<ClaudeOAuthScope> {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, {
        message: "Claude subscriptions are not enabled",
      });
    requireSameOriginBrowserMutation(c, deps);
    const id = z
      .string()
      .uuid()
      .safeParse(c.req.param(organization ? "organizationId" : "workspaceId"));
    if (!id.success) throw new HTTPException(404, { message: "Scope not found" });
    if (organization) {
      const human = await requireOrganizationCodexHuman(c, deps, id.data);
      return {
        accountId: id.data,
        workspaceId: null,
        actorSubjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      };
    }
    const grant = await (fresh ? requireFreshAccessGrant : requireAccessGrant)(
      c,
      deps,
      id.data,
      "connections:write",
    );
    const human = await managedCookieHuman(c, deps);
    if (human && human.subjectId === grant.subjectId)
      return {
        accountId: grant.accountId,
        workspaceId: id.data,
        actorSubjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      };
    if (
      deps.settings.productAccessMode === "local" &&
      grant.subjectId &&
      !c.req.header("authorization")
    )
      return {
        accountId: grant.accountId,
        workspaceId: id.data,
        actorSubjectId: grant.subjectId,
        browserSessionHash: await hashCodexBrowserSession("local:" + grant.subjectId),
      };
    throw new HTTPException(401, {
      message: "Sign in to OpenGeni to connect Claude.",
    });
  }
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/model-providers/claude_subscription/oauth"
      : "/v1/workspaces/:workspaceId/model-providers/claude_subscription/oauth";
    app.post(`${path}/start`, async (c) =>
      c.json(
        verifiedDelegatedHumanAuthorizationForRequest(c.req.raw)
          ? await startDelegatedClaudeOAuth(c, deps, organization)
          : await startClaudeSubscriptionOAuth(deps, await scope(c, organization)),
      ),
    );
    app.post(`${path}/complete`, async (c) => {
      const inputScope = await scope(c, organization);
      const payload = ClaudeSubscriptionOAuthCompleteRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!payload.success)
        throw new HTTPException(422, {
          message: "Enter the authorization code from Claude.",
        });
      const reauthorize = async () => {
        const fresh = await scope(c, organization, true);
        if (
          fresh.accountId !== inputScope.accountId ||
          fresh.workspaceId !== inputScope.workspaceId ||
          fresh.actorSubjectId !== inputScope.actorSubjectId ||
          fresh.browserSessionHash !== inputScope.browserSessionHash
        )
          throw new HTTPException(403, {
            message: "Your access changed during Claude sign-in. Start again.",
          });
      };
      await adoptDelegatedClaudeAttempt(deps, inputScope, payload.data, reauthorize);
      return c.json(
        await completeClaudeSubscriptionOAuth(
          deps,
          inputScope,
          payload.data,
          reauthorize,
          fetchImpl,
        ),
      );
    });
  }
}
