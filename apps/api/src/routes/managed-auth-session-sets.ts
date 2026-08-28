import { randomUUID } from "node:crypto";
import {
  BeginManagedAuthLoginTransactionRequest,
  BootstrapManagedAuthSessionSetRequest,
  CancelManagedAuthLoginTransactionRequest,
  CompleteManagedAuthEmailPasswordTransactionRequest,
  CompleteManagedAuthLoginTransactionResponse,
  LogoutManagedAuthLoginSlotRequest,
  LogoutManagedAuthSessionSetRequest,
  MANAGED_AUTH_TRANSACTION_TTL_SECONDS,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  ManagedAuthDeepLinkResolution,
  ManagedAuthLoginTransaction,
  ManagedAuthSessionSetProjection,
  ManagedAuthSessionSetErrorCode,
  ResolveManagedAuthDeepLinkRequest,
  SelectManagedAuthLoginSlotRequest,
  StartManagedAuthSocialTransactionRequest,
  StartManagedAuthSocialTransactionResponse,
  type ManagedAuthSessionSetProjection as ManagedAuthSessionSetProjectionType,
  type ManagedAuthSessionSetErrorCode as ManagedAuthSessionSetErrorCodeType,
} from "@opengeni/contracts/managed-auth-session-sets";
import { hasPermission, requireSessionAuthorization, type ApiRouteDeps } from "@opengeni/core";
import {
  authenticateAndAdoptManagedAuthSession,
  isolatedManagedAuthHeaders,
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE_PATH,
  MANAGED_AUTH_SESSION_SET_COOKIE,
  ManagedAuthActorChangeError,
  ManagedAuthCompletionOutcomeUnknownError,
  ManagedAuthRequestAdmissionError,
  managedAuthCsrfHash,
  managedAuthDerivedUuid,
  managedAuthRandomAuthority,
  managedAuthSecretRequestDigest,
  managedAuthSha256,
  managedAuthTransactionSecret,
  requireManagedAuthMutationAdmission,
  resolveManagedAuthSelectedSession,
  withManagedAuthCsrfToken,
} from "@opengeni/core/managed-auth-session-sets";
import {
  beginManagedAuthLoginTransaction,
  bootstrapManagedAuthSessionSet,
  getManagedAuthAdoptedSessionSnapshot,
  getManagedAuthSessionSetOperationReceipt,
  getManagedAuthSessionSetSnapshot,
  getManagedAuthSessionSetAuthorityState,
  ManagedAuthLoginSlotLimitError,
  ManagedAuthLoginSlotAlreadyExistsError,
  ManagedAuthLoginSlotUnavailableError,
  ManagedAuthActorMutationInFlightError,
  ManagedAuthLoginTransactionRateLimitError,
  ManagedAuthSessionSetAuthorityError,
  ManagedAuthSessionSetGenerationConflictError,
  ManagedAuthSessionSetOperationReuseError,
  mutateManagedAuthSessionSet,
} from "@opengeni/db/managed-auth-session-sets";
import { ensureManagedAccessForUser, getSession } from "@opengeni/db";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../http/api-error";
import { z } from "zod";

const ManagedAuthSocialStartReceipt = z
  .object({
    version: z.literal(1),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    url: z.string().url().max(4_096),
    stateCookie: z.string().min(1).max(4_096),
  })
  .strict();

export function registerManagedAuthSessionSetRoutes(app: Hono, deps: ApiRouteDeps): void {
  const noStore = async (context: Context, next: () => Promise<void>) => {
    context.header("cache-control", "no-store");
    context.header("pragma", "no-cache");
    if (deps.settings.managedAuthSessionSetMode === "broker") {
      appendCookies(
        context,
        await requireAvailable(deps).adapter.createLegacySelectedSessionCookies(
          null,
          context.req.header("cookie") ?? null,
        ),
      );
    }
    await next();
  };
  app.use("/v1/auth/session-set", noStore);
  app.use("/v1/auth/session-set/*", noStore);

  app.get("/v1/auth/get-session", async (context) => {
    if (deps.settings.managedAuthSessionSetMode === "legacy") {
      if (!deps.managedAuth) throw new HTTPException(404);
      return await deps.managedAuth.handler(context.req.raw);
    }
    context.header("cache-control", "no-store");
    const available = requireAvailable(deps);
    if (deps.settings.managedAuthSessionSetMode === "broker") {
      appendCookies(
        context,
        await available.adapter.createLegacySelectedSessionCookies(
          null,
          context.req.header("cookie") ?? null,
        ),
      );
    }
    const authority = getAuthority(context);
    try {
      if (authority) {
        const expectedActorEpoch = context.req.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER) ?? null;
        const ambient =
          deps.settings.managedAuthSessionSetMode === "dual" && expectedActorEpoch === null
            ? await available.adapter.resolveAmbientSession(context.req.raw.headers)
            : null;
        const selected = await resolveManagedAuthSelectedSession({
          db: deps.db,
          adapter: available.adapter,
          authority,
          mode: deps.settings.managedAuthSessionSetMode,
          expectedActorEpoch,
          legacyAmbientSessionId: ambient?.session.id ?? null,
        });
        if (!selected?.session) return context.json(null);
        return jsonWithActorEpoch(
          context,
          selected.projection.actorEpoch,
          safeBetterAuthSession(selected.session),
        );
      }
      if (deps.settings.managedAuthSessionSetMode === "broker") return context.json(null);
      const ambient = await available.adapter.resolveAmbientSession(context.req.raw.headers);
      if (!ambient?.session.id) return context.json(null);
      const adopted = await getManagedAuthAdoptedSessionSnapshot(deps.db, ambient.session.id);
      if (adopted) {
        if (
          adopted.actorEpoch !== "1" ||
          !adopted.selected ||
          adopted.selected.authSessionId !== ambient.session.id ||
          adopted.selected.authUserId !== ambient.user.id
        ) {
          throw new ManagedAuthActorChangeError();
        }
        return jsonWithActorEpoch(context, adopted.actorEpoch, safeBetterAuthSession(ambient));
      }
      return context.json(safeBetterAuthSession(ambient));
    } catch (error) {
      if (error instanceof ManagedAuthActorChangeError) {
        context.header("x-opengeni-actor-state", "changed");
        throw managedAuthApiError(409, "actor_change_required", { cause: error });
      }
      throw error;
    }
  });

  app.get("/v1/auth/session-set", async (context) => {
    requireAvailable(deps);
    const existingAuthority = getAuthority(context);
    const snapshot = existingAuthority ? await snapshotFor(deps, existingAuthority) : null;
    if (snapshot && existingAuthority) {
      return jsonWithActorEpoch(
        context,
        snapshot.projection.actorEpoch,
        project(deps, existingAuthority, snapshot.projection),
      );
    }
    if (
      existingAuthority &&
      (await getManagedAuthSessionSetAuthorityState(
        deps.db,
        managedAuthSha256(existingAuthority),
      )) === "absent"
    ) {
      const projection = emptyProjection(deps, existingAuthority);
      return jsonWithActorEpoch(context, projection.actorEpoch, projection);
    }
    const authority = managedAuthRandomAuthority();
    setAuthorityCookie(context, deps, authority);
    const projection = emptyProjection(deps, authority);
    return jsonWithActorEpoch(context, projection.actorEpoch, projection);
  });

  app.post("/v1/auth/session-set/bootstrap", async (context) => {
    const body = await bodyAs(context, BootstrapManagedAuthSessionSetRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    const ambient = await requireAvailable(deps).managedAuth!.api.getSession({
      headers: context.req.raw.headers,
      returnHeaders: true,
    });
    const authSessionId = ambient.response?.session?.id;
    if (typeof authSessionId !== "string") {
      throw managedAuthApiError(401, "managed_authentication_required");
    }
    try {
      const projection = await bootstrapManagedAuthSessionSet(deps.db, {
        authorityHash: managedAuthSha256(authority),
        csrfHash: managedAuthCsrfHash(authority),
        authSessionId,
        mode: deps.settings.managedAuthSessionSetMode,
        operationId: body.operationId,
        requestDigest: digest(deps, body),
        expectedGeneration: body.expectedGeneration,
        expectedActorEpoch: actorEpoch,
      });
      if (deps.settings.managedAuthSessionSetMode === "dual") {
        for (const cookie of setCookieHeaders(ambient.headers)) {
          context.header("set-cookie", cookie, { append: true });
        }
      } else {
        appendCookies(
          context,
          await requireAvailable(deps).adapter.createLegacySelectedSessionCookies(
            null,
            context.req.header("cookie") ?? null,
          ),
        );
      }
      return jsonWithActorEpoch(
        context,
        projection.actorEpoch,
        project(deps, authority, projection),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/transactions", async (context) => {
    const body = await bodyAs(context, BeginManagedAuthLoginTransactionRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    const transactionId = randomUUID();
    const transactionSecret = managedAuthTransactionSecret(
      requireSigningSecret(deps),
      authority,
      body.operationId,
    );
    try {
      const transaction = ManagedAuthLoginTransaction.parse(
        await beginManagedAuthLoginTransaction(deps.db, {
          authorityHash: managedAuthSha256(authority),
          csrfHash: managedAuthCsrfHash(authority),
          rateScopeHash: loginTransactionClientScope(context, deps),
          operationId: body.operationId,
          requestDigest: digest(deps, body),
          expectedGeneration: body.expectedGeneration,
          expectedActorEpoch: actorEpoch,
          transactionId,
          transactionSecretHash: managedAuthSha256(transactionSecret),
          kind: body.kind,
          targetSlotId: body.slotId ?? null,
          returnIntentId: body.returnIntent
            ? managedAuthDerivedUuid("opengeni:managed-auth:return-intent", body.operationId)
            : null,
          returnPath: body.returnIntent ?? null,
          expiresAt: new Date(Date.now() + 600_000),
        }),
      );
      setTransactionCookie(context, deps, transaction.id, transactionSecret);
      return jsonWithActorEpoch(context, actorEpoch, transaction);
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/transactions/email-password", async (context) => {
    const body = await bodyAs(context, CompleteManagedAuthEmailPasswordTransactionRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    const available = requireAvailable(deps);
    const requestDigest = digest(deps, body);
    try {
      let completed: Awaited<ReturnType<typeof getManagedAuthSessionSetOperationReceipt>>;
      try {
        completed = await getManagedAuthSessionSetOperationReceipt(deps.db, {
          authorityHash: managedAuthSha256(authority),
          operationId: body.operationId,
          requestDigest,
        });
      } catch (error) {
        throw new ManagedAuthCompletionOutcomeUnknownError({ cause: error });
      }
      if (!completed) {
        const transactionSecret = requireTransactionSecret(context, body.transactionId);
        completed = await authenticateAndAdoptManagedAuthSession({
          db: deps.db,
          adapter: available.adapter,
          isolatedHeaders: isolatedManagedAuthHeaders(context.req.raw),
          authority,
          csrfHash: managedAuthCsrfHash(authority),
          operationId: body.operationId,
          requestDigest,
          expectedGeneration: body.expectedGeneration,
          expectedActorEpoch: actorEpoch,
          transactionId: body.transactionId,
          transactionSecret,
          email: body.email,
          password: body.password,
          mode: deps.settings.managedAuthSessionSetMode,
        });
      }
      deleteCookie(context, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE, transactionCookieOptions(deps));
      await mirrorCurrentSelection(context, deps, authority);
      return jsonWithActorEpoch(
        context,
        completed.projection.actorEpoch,
        CompleteManagedAuthLoginTransactionResponse.parse({
          projection: project(deps, authority, completed.projection),
          returnIntent: completed.returnIntent,
        }),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/transactions/social", async (context) => {
    const body = await bodyAs(context, StartManagedAuthSocialTransactionRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    const available = requireAvailable(deps);
    if (!managedAuthSocialProviderConfigured(deps, body.provider)) {
      throw managedAuthApiError(404, "managed_authentication_unavailable");
    }
    const transactionSecret = requireTransactionSecret(context, body.transactionId);
    const publicBaseUrl = deps.settings.publicBaseUrl;
    if (!publicBaseUrl) {
      throw managedAuthApiError(503, "managed_authentication_unavailable", { retryable: true });
    }
    const callbackURL = new URL("/account-auth", publicBaseUrl);
    callbackURL.searchParams.set("transaction", body.transactionId);
    callbackURL.searchParams.set("social", "complete");
    const errorCallbackURL = new URL(callbackURL);
    errorCallbackURL.searchParams.set("social", "error");
    try {
      const requestDigest = digest(deps, body);
      const receiptIdentifier = `opengeni-managed-social-start:${body.operationId}`;
      const receipt = await deps.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${receiptIdentifier}, 0))`,
        );
        const authContext = await available.managedAuth.$context;
        const stored = await authContext.internalAdapter.findVerificationValue(receiptIdentifier);
        if (stored && new Date(stored.expiresAt).getTime() > Date.now()) {
          let parsed: ReturnType<typeof ManagedAuthSocialStartReceipt.safeParse>;
          try {
            parsed = ManagedAuthSocialStartReceipt.safeParse(JSON.parse(stored.value));
          } catch (error) {
            throw new ManagedAuthCompletionOutcomeUnknownError({ cause: error });
          }
          if (!parsed.success) {
            throw new ManagedAuthCompletionOutcomeUnknownError({ cause: parsed.error });
          }
          if (parsed.data.requestDigest !== requestDigest) {
            throw new ManagedAuthSessionSetOperationReuseError();
          }
          return parsed.data;
        }
        if (stored) {
          await authContext.internalAdapter.deleteVerificationByIdentifier(receiptIdentifier);
        }
        const result = await available.managedAuth.api.signInSocial({
          body: {
            provider: body.provider,
            disableRedirect: true,
            callbackURL: callbackURL.toString(),
            errorCallbackURL: errorCallbackURL.toString(),
            additionalData: {
              opengeniManagedAuth: {
                version: 1,
                operationId: body.operationId,
                provider: body.provider,
                transactionId: body.transactionId,
                authorityHash: managedAuthSha256(authority),
                transactionSecretHash: managedAuthSha256(transactionSecret),
                expectedGeneration: body.expectedGeneration,
                expectedActorEpoch: actorEpoch,
              },
            },
          },
          headers: isolatedManagedAuthHeaders(context.req.raw),
          returnHeaders: true,
        });
        const url = result.response?.url;
        const stateCookieName = authContext.createAuthCookie("state").name;
        const stateCookie = setCookieHeaders(result.headers).find((cookie) =>
          cookie.startsWith(`${stateCookieName}=`),
        );
        const parsed = ManagedAuthSocialStartReceipt.parse({
          version: 1,
          requestDigest,
          url,
          stateCookie,
        });
        const created = await authContext.internalAdapter.createVerificationValue({
          identifier: receiptIdentifier,
          value: JSON.stringify(parsed),
          expiresAt: new Date(Date.now() + MANAGED_AUTH_TRANSACTION_TTL_SECONDS * 1_000),
        });
        if (!created) {
          throw new ManagedAuthCompletionOutcomeUnknownError();
        }
        return parsed;
      });
      context.header("set-cookie", receipt.stateCookie, { append: true });
      return jsonWithActorEpoch(
        context,
        actorEpoch,
        StartManagedAuthSocialTransactionResponse.parse({ url: receipt.url }),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.delete("/v1/auth/session-set/transactions/:transactionId", async (context) => {
    const body = await bodyAs(context, CancelManagedAuthLoginTransactionRequest);
    if (body.transactionId !== context.req.param("transactionId")) invalid();
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    const transactionSecret = requireTransactionSecret(context, body.transactionId);
    try {
      const projection = await mutateManagedAuthSessionSet(deps.db, {
        authorityHash: managedAuthSha256(authority),
        csrfHash: managedAuthCsrfHash(authority),
        operationId: body.operationId,
        requestDigest: digest(deps, body),
        expectedGeneration: body.expectedGeneration,
        expectedActorEpoch: actorEpoch,
        operationType: "cancel_transaction",
        transactionId: body.transactionId,
        transactionSecretHash: managedAuthSha256(transactionSecret),
        mode: deps.settings.managedAuthSessionSetMode,
      });
      deleteCookie(context, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE, transactionCookieOptions(deps));
      return jsonWithActorEpoch(
        context,
        (projection as ManagedAuthSessionSetProjectionType).actorEpoch,
        project(deps, authority, projection as never),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/select", async (context) => {
    const body = await bodyAs(context, SelectManagedAuthLoginSlotRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    try {
      const projection = await mutateManagedAuthSessionSet(deps.db, {
        authorityHash: managedAuthSha256(authority),
        csrfHash: managedAuthCsrfHash(authority),
        operationId: body.operationId,
        requestDigest: digest(deps, body),
        expectedGeneration: body.expectedGeneration,
        expectedActorEpoch: actorEpoch,
        operationType: "select",
        targetSlotId: body.slotId,
        mode: deps.settings.managedAuthSessionSetMode,
      });
      await mirrorCurrentSelection(context, deps, authority);
      return jsonWithActorEpoch(
        context,
        (projection as ManagedAuthSessionSetProjectionType).actorEpoch,
        project(deps, authority, projection as never),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/logout-one", async (context) => {
    const body = await bodyAs(context, LogoutManagedAuthLoginSlotRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    try {
      const projection = await mutateManagedAuthSessionSet(deps.db, {
        authorityHash: managedAuthSha256(authority),
        csrfHash: managedAuthCsrfHash(authority),
        operationId: body.operationId,
        requestDigest: digest(deps, body),
        expectedGeneration: body.expectedGeneration,
        expectedActorEpoch: actorEpoch,
        operationType: "logout_one",
        targetSlotId: body.slotId,
        replacementSlotId: body.replacementSlotId,
        mode: deps.settings.managedAuthSessionSetMode,
      });
      await mirrorCurrentSelection(context, deps, authority);
      return jsonWithActorEpoch(
        context,
        (projection as ManagedAuthSessionSetProjectionType).actorEpoch,
        project(deps, authority, projection as never),
      );
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/logout-all", async (context) => {
    const body = await bodyAs(context, LogoutManagedAuthSessionSetRequest);
    const { authority, actorEpoch } = await requireMutation(context, deps, body.expectedGeneration);
    try {
      const receipt = await mutateManagedAuthSessionSet(deps.db, {
        authorityHash: managedAuthSha256(authority),
        csrfHash: managedAuthCsrfHash(authority),
        operationId: body.operationId,
        requestDigest: digest(deps, body),
        expectedGeneration: body.expectedGeneration,
        expectedActorEpoch: actorEpoch,
        operationType: "logout_all",
        mode: deps.settings.managedAuthSessionSetMode,
      });
      // Keep the now-retired authority cookie until the next authoritative GET
      // rotates it. If response headers commit but the body is lost, the SDK
      // can still replay this exact operation and recover its durable receipt;
      // every new command remains denied by the revoked server-side set.
      appendCookies(
        context,
        await requireAvailable(deps).adapter.createLegacySelectedSessionCookies(
          null,
          context.req.header("cookie") ?? null,
        ),
      );
      return jsonWithActorEpoch(context, receipt.actorEpoch, receipt);
    } catch (error) {
      throwHttp(error);
    }
  });

  app.post("/v1/auth/session-set/deep-link/resolve", async (context) => {
    const body = await bodyAs(context, ResolveManagedAuthDeepLinkRequest);
    const authority = getAuthority(context);
    if (!authority)
      return context.json(ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" }));
    const snapshot = await snapshotFor(deps, authority);
    if (!snapshot)
      return context.json(ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" }));
    requireApiContract(context);
    try {
      requireManagedAuthMutationAdmission({
        request: context.req.raw,
        allowedOrigins: allowedOrigins(deps),
        authority,
        signingSecret: requireSigningSecret(deps),
        expectedGeneration: snapshot.projection.generation,
      });
    } catch (error) {
      if (error instanceof ManagedAuthRequestAdmissionError) {
        throw managedAuthApiError(403, "origin_rejected", { cause: error });
      }
      throw error;
    }
    requireActorEpoch(context, snapshot.projection);
    return jsonWithActorEpoch(
      context,
      snapshot.projection.actorEpoch,
      await resolveCanonicalDeepLink(deps, authority, body.path, snapshot.projection.actorEpoch),
    );
  });
}

/**
 * Better Auth 1.6.26 provider lifecycle routes retained while session-set mode
 * owns all selected-session reads, enumeration, revocation, and user mutation.
 * The list is intentionally exact so a dependency upgrade cannot silently add
 * a selected-session capability under the wildcard.
 */
export function requireManagedAuthProviderRouteAllowed(method: string, pathname: string): void {
  const normalizedMethod = method.toUpperCase();
  const allowed =
    (normalizedMethod === "POST" &&
      new Set([
        "/v1/auth/sign-up/email",
        "/v1/auth/sign-in/email",
        "/v1/auth/send-verification-email",
        "/v1/auth/request-password-reset",
        "/v1/auth/reset-password",
      ]).has(pathname)) ||
    (normalizedMethod === "GET" &&
      (pathname === "/v1/auth/verify-email" ||
        pathname === "/v1/auth/error" ||
        pathname === "/v1/auth/ok" ||
        /^\/v1\/auth\/callback\/(?:google|github)$/.test(pathname) ||
        /^\/v1\/auth\/reset-password\/[^/]+$/.test(pathname)));
  if (!allowed) throw managedAuthApiError(409, "provider_route_blocked");
}

function managedAuthSocialProviderConfigured(
  deps: ApiRouteDeps,
  provider: "google" | "github",
): boolean {
  return provider === "google"
    ? Boolean(
        deps.settings.managedAuthGoogleClientId && deps.settings.managedAuthGoogleClientSecret,
      )
    : Boolean(
        deps.settings.managedAuthGithubClientId && deps.settings.managedAuthGithubClientSecret,
      );
}

/** Remove provider bearer/session material and enforce browser-auth cache/cookie policy. */
export async function scrubManagedAuthProviderResponse(
  response: Response,
  options: {
    replacementCookies?: readonly string[] | undefined;
    preserveCookieNames?: readonly string[] | undefined;
  } = {},
): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  if (options.replacementCookies !== undefined) {
    const preserved = setCookieHeaders(response.headers).filter((cookie) =>
      options.preserveCookieNames?.some((name) => cookie.startsWith(`${name}=`)),
    );
    headers.delete("set-cookie");
    for (const cookie of preserved) headers.append("set-cookie", cookie);
    for (const cookie of options.replacementCookies) headers.append("set-cookie", cookie);
  }
  let body: BodyInit | null = response.body;
  if (contentType.includes("application/json")) {
    const value = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (value !== undefined) {
      headers.delete("content-length");
      body = JSON.stringify(removeProviderSecrets(value));
    }
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function removeProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeProviderSecrets);
  if (!value || typeof value !== "object") return value;
  const secretKeys = new Set([
    "token",
    "session",
    "accessToken",
    "refreshToken",
    "idToken",
    "access_token",
    "refresh_token",
    "id_token",
  ]);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretKeys.has(key))
      .map(([key, child]) => [key, removeProviderSecrets(child)]),
  );
}

function jsonWithActorEpoch(context: Context, actorEpoch: string, value: unknown): Response {
  context.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER, actorEpoch);
  return context.json(value);
}

function safeBetterAuthSession(resolved: {
  session: { id: string; userId: string; [key: string]: unknown };
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    [key: string]: unknown;
  };
}) {
  const safeDate = (value: unknown): string | Date | undefined =>
    value instanceof Date || typeof value === "string" ? value : undefined;
  const session = resolved.session;
  const user = resolved.user;
  return {
    session: {
      id: session.id,
      userId: session.userId,
      ...(safeDate(session.createdAt) ? { createdAt: safeDate(session.createdAt) } : {}),
      ...(safeDate(session.updatedAt) ? { updatedAt: safeDate(session.updatedAt) } : {}),
      ...(safeDate(session.expiresAt) ? { expiresAt: safeDate(session.expiresAt) } : {}),
      ...(typeof session.ipAddress === "string" ? { ipAddress: session.ipAddress } : {}),
      ...(typeof session.userAgent === "string" ? { userAgent: session.userAgent } : {}),
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      ...(typeof user.image === "string" ? { image: user.image } : {}),
      ...(safeDate(user.createdAt) ? { createdAt: safeDate(user.createdAt) } : {}),
      ...(safeDate(user.updatedAt) ? { updatedAt: safeDate(user.updatedAt) } : {}),
    },
  };
}

async function resolveCanonicalDeepLink(
  deps: ApiRouteDeps,
  authority: string,
  path: string,
  expectedActorEpoch: string,
) {
  const target = parseSupportedDeepLink(path);
  if (!target) return ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" });
  const snapshot = await getManagedAuthSessionSetSnapshot(deps.db, {
    authorityHash: managedAuthSha256(authority),
    mode: deps.settings.managedAuthSessionSetMode,
    includeInternal: true,
    readOnly: true,
  });
  if (!snapshot) return ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" });
  if (snapshot.projection.actorEpoch !== expectedActorEpoch) {
    throw managedAuthApiError(409, "actor_change_required");
  }
  const adapter = requireAvailable(deps).adapter;
  const selectedSlotId = snapshot.projection.selectedSlotId;
  const orderedSlots = [
    ...snapshot.internalSlots.filter((slot) => slot.slotId === selectedSlotId),
    ...snapshot.internalSlots.filter((slot) => slot.slotId !== selectedSlotId),
  ];
  const eligibleSlotIds: string[] = [];
  for (const slot of orderedSlots) {
    const resolved = await adapter.resolveSelectedSession(slot);
    if (
      !resolved ||
      resolved.session.id !== slot.authSessionId ||
      resolved.user.id !== slot.authUserId
    ) {
      continue;
    }
    const access = await ensureManagedAccessForUser(deps.db, {
      userId: resolved.user.id,
      email: resolved.user.email,
      name: resolved.user.name,
      emailVerified: resolved.user.emailVerified,
      provisionFallbackOrganization: false,
      bindPendingInvitations: false,
    });
    const grants = target.workspaceId
      ? access.workspaceGrants.filter((grant) => grant.workspaceId === target.workspaceId)
      : access.workspaceGrants;
    let authorized = false;
    for (const grant of grants) {
      if (
        !hasPermission(grant.permissions, target.sessionId ? "sessions:read" : target.permission)
      ) {
        continue;
      }
      if (target.sessionId) {
        const session = await getSession(deps.db, grant.workspaceId, target.sessionId);
        if (!session) continue;
        try {
          await requireSessionAuthorization(deps, grant, {
            sessionId: target.sessionId,
            operation: "session.read",
            surface: "http",
          });
        } catch {
          continue;
        }
      }
      authorized = true;
      break;
    }
    if (authorized) {
      if (slot.slotId === selectedSlotId) {
        return ManagedAuthDeepLinkResolution.parse({ kind: "current" });
      }
      eligibleSlotIds.push(slot.slotId);
    }
  }
  if (eligibleSlotIds.length !== 1) {
    return ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" });
  }
  const safeSlot = snapshot.projection.slots.find((slot) => slot.id === eligibleSlotIds[0]);
  return safeSlot
    ? ManagedAuthDeepLinkResolution.parse({ kind: "switch_required", slot: safeSlot })
    : ManagedAuthDeepLinkResolution.parse({ kind: "unavailable" });
}

export function parseSupportedDeepLink(path: string): {
  workspaceId: string | null;
  sessionId: string | null;
  permission: "workspace:read" | "sessions:read";
} | null {
  if (
    /%(?:00|2f|5c)/i.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return null;
  let url: URL;
  try {
    url = new URL(path, "https://opengeni.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://opengeni.invalid") return null;
  if (url.search || url.hash) return null;
  const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
  const workspace = url.pathname.match(new RegExp(`^/workspaces/${uuid}$`, "i"));
  if (workspace?.[1]) {
    return { workspaceId: workspace[1], sessionId: null, permission: "workspace:read" };
  }
  const sessionIndex = url.pathname.match(new RegExp(`^/workspaces/${uuid}/sessions$`, "i"));
  if (sessionIndex?.[1]) {
    return { workspaceId: sessionIndex[1], sessionId: null, permission: "sessions:read" };
  }
  const workspaceSession = url.pathname.match(
    new RegExp(`^/workspaces/${uuid}/sessions/${uuid}$`, "i"),
  );
  if (workspaceSession?.[1] && workspaceSession[2]) {
    return {
      workspaceId: workspaceSession[1],
      sessionId: workspaceSession[2],
      permission: "sessions:read",
    };
  }
  const compatibilitySession = url.pathname.match(new RegExp(`^/sessions/${uuid}$`, "i"));
  return compatibilitySession?.[1]
    ? { workspaceId: null, sessionId: compatibilitySession[1], permission: "sessions:read" }
    : null;
}

function requireAvailable(deps: ApiRouteDeps) {
  if (
    deps.settings.productAccessMode !== "managed" ||
    deps.settings.managedAuthSessionSetMode === "legacy" ||
    !deps.managedAuth ||
    !deps.managedAuthSessionAdapter
  ) {
    throw managedAuthApiError(404, "browser_session_set_unavailable");
  }
  requireSigningSecret(deps);
  return { managedAuth: deps.managedAuth, adapter: deps.managedAuthSessionAdapter };
}

function requireSigningSecret(deps: ApiRouteDeps): string {
  const secret = deps.settings.betterAuthSecret;
  if (!secret)
    throw managedAuthApiError(503, "managed_authentication_unavailable", { retryable: true });
  return secret;
}

async function bodyAs<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) invalid();
  return parsed.data;
}

function invalid(): never {
  throw managedAuthApiError(422, "invalid_browser_session_set_request");
}

function getAuthority(context: Context): string | null {
  const value = getCookie(context, MANAGED_AUTH_SESSION_SET_COOKIE);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

async function requireMutation(
  context: Context,
  deps: ApiRouteDeps,
  expectedGeneration: string,
): Promise<{ authority: string; actorEpoch: string }> {
  requireAvailable(deps);
  requireApiContract(context);
  const authority = getAuthority(context);
  if (!authority) throw managedAuthApiError(401, "browser_session_set_required");
  try {
    requireManagedAuthMutationAdmission({
      request: context.req.raw,
      allowedOrigins: allowedOrigins(deps),
      authority,
      signingSecret: requireSigningSecret(deps),
      expectedGeneration,
    });
  } catch (error) {
    if (error instanceof ManagedAuthRequestAdmissionError) {
      throw managedAuthApiError(403, "origin_rejected", { cause: error });
    }
    throw error;
  }
  const actorEpoch = context.req.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER);
  if (!actorEpoch || !/^[1-9][0-9]*$/.test(actorEpoch)) {
    context.header("x-opengeni-actor-state", "changed");
    throw managedAuthApiError(409, "actor_change_required");
  }
  return { authority, actorEpoch };
}

function requireApiContract(context: Context): void {
  if (
    context.req.header(MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER) !==
    MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION
  ) {
    throw managedAuthApiError(409, "api_contract_changed");
  }
}

function requireActorEpoch(context: Context, projection: { actorEpoch: string }): void {
  if (context.req.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER) !== projection.actorEpoch) {
    context.header("x-opengeni-actor-state", "changed");
    throw managedAuthApiError(409, "actor_change_required");
  }
}

async function snapshotFor(deps: ApiRouteDeps, authority: string) {
  return await getManagedAuthSessionSetSnapshot(deps.db, {
    authorityHash: managedAuthSha256(authority),
    mode: deps.settings.managedAuthSessionSetMode,
    readOnly: true,
  });
}

function project(
  deps: ApiRouteDeps,
  authority: string,
  projection: Omit<ManagedAuthSessionSetProjectionType, "csrfToken">,
): ManagedAuthSessionSetProjectionType {
  return ManagedAuthSessionSetProjection.parse(
    withManagedAuthCsrfToken(projection, requireSigningSecret(deps), authority),
  );
}

function emptyProjection(deps: ApiRouteDeps, authority: string) {
  return project(deps, authority, {
    mode: deps.settings.managedAuthSessionSetMode,
    generation: "1",
    actorEpoch: "1",
    selectedSlotId: null,
    state: "ready",
    slots: [],
  });
}

function digest(deps: ApiRouteDeps, value: unknown): string {
  return managedAuthSecretRequestDigest(requireSigningSecret(deps), value);
}

function loginTransactionClientScope(context: Context, deps: ApiRouteDeps): string {
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || context.req.header("x-real-ip")?.trim() || "unknown";
  return digest(deps, {
    purpose: "managed-auth-login-transaction-rate-limit",
    client: address.slice(0, 128),
  });
}

function allowedOrigins(deps: ApiRouteDeps): string[] {
  const origins = new Set<string>();
  for (const candidate of [
    deps.settings.publicBaseUrl,
    deps.settings.webBaseUrl,
    ...deps.settings.betterAuthTrustedOrigins.split(","),
  ]) {
    if (!candidate?.trim()) continue;
    try {
      origins.add(new URL(candidate.trim()).origin);
    } catch {
      continue;
    }
  }
  return [...origins];
}

function setAuthorityCookie(context: Context, deps: ApiRouteDeps, authority: string): void {
  setCookie(context, MANAGED_AUTH_SESSION_SET_COOKIE, authority, authorityCookieOptions(deps));
}

function authorityCookieOptions(deps: ApiRouteDeps) {
  return {
    httpOnly: true,
    secure: deps.settings.publicBaseUrl?.startsWith("https://") ?? false,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 180 * 24 * 60 * 60,
  };
}

function transactionCookieOptions(deps: ApiRouteDeps) {
  return {
    httpOnly: true,
    secure: deps.settings.publicBaseUrl?.startsWith("https://") ?? false,
    sameSite: "Strict" as const,
    path: MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE_PATH,
    maxAge: 600,
  };
}

function setTransactionCookie(
  context: Context,
  deps: ApiRouteDeps,
  transactionId: string,
  transactionSecret: string,
): void {
  setCookie(
    context,
    MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
    `${transactionId}.${transactionSecret}`,
    transactionCookieOptions(deps),
  );
}

function requireTransactionSecret(context: Context, transactionId: string): string {
  const value = getCookie(context, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
  const prefix = `${transactionId}.`;
  const secret = value?.startsWith(prefix) ? value.slice(prefix.length) : null;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw managedAuthApiError(401, "invalid_transaction");
  }
  return secret;
}

async function mirrorCurrentSelection(
  context: Context,
  deps: ApiRouteDeps,
  authority: string,
): Promise<void> {
  if (deps.settings.managedAuthSessionSetMode !== "dual") return;
  const snapshot = await getManagedAuthSessionSetSnapshot(deps.db, {
    authorityHash: managedAuthSha256(authority),
    mode: "dual",
    includeInternal: true,
    readOnly: true,
  });
  appendCookies(
    context,
    await requireAvailable(deps).adapter.createLegacySelectedSessionCookies(
      snapshot?.selected ?? null,
      context.req.header("cookie") ?? null,
    ),
  );
}

function appendCookies(context: Context, cookies: readonly string[]): void {
  for (const cookie of cookies) context.header("set-cookie", cookie, { append: true });
}

function throwHttp(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof ManagedAuthSessionSetGenerationConflictError) {
    throw managedAuthApiError(409, "generation_conflict", { cause: error, retryable: true });
  }
  if (error instanceof ManagedAuthSessionSetOperationReuseError) {
    throw managedAuthApiError(409, "operation_reused", { cause: error });
  }
  if (error instanceof ManagedAuthLoginSlotUnavailableError) {
    throw managedAuthApiError(409, "slot_unavailable", { cause: error });
  }
  if (error instanceof ManagedAuthLoginSlotLimitError) {
    throw managedAuthApiError(409, "slot_limit_reached", { cause: error });
  }
  if (error instanceof ManagedAuthLoginSlotAlreadyExistsError) {
    throw managedAuthApiError(409, "slot_already_exists", { cause: error });
  }
  if (error instanceof ManagedAuthActorMutationInFlightError) {
    throw managedAuthApiError(409, "actor_mutation_in_flight", { cause: error, retryable: true });
  }
  if (error instanceof ManagedAuthLoginTransactionRateLimitError) {
    throw managedAuthApiError(429, "login_transaction_rate_limited", {
      cause: error,
      retryable: true,
    });
  }
  if (error instanceof ManagedAuthSessionSetAuthorityError) {
    throw managedAuthApiError(401, "browser_session_set_required", { cause: error });
  }
  if (error instanceof ManagedAuthCompletionOutcomeUnknownError) {
    throw managedAuthApiError(503, "operation_outcome_unknown", {
      cause: error,
      retryable: true,
      outcomeUnknown: true,
    });
  }
  throw error;
}

function managedAuthApiError(
  status: 401 | 403 | 404 | 409 | 422 | 429 | 503,
  code: ManagedAuthSessionSetErrorCodeType,
  options: {
    cause?: unknown;
    retryable?: boolean;
    outcomeUnknown?: boolean;
  } = {},
): ApiHttpError {
  ManagedAuthSessionSetErrorCode.parse(code);
  const outerCode =
    status === 401
      ? "unauthenticated"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 422
            ? "validation_failed"
            : status === 429
              ? "limit_exceeded"
              : status === 503
                ? "upstream_unavailable"
                : code === "operation_reused"
                  ? "idempotency_conflict"
                  : "conflict";
  const error = new ApiHttpError(status, {
    code: outerCode,
    message: code,
    retryable: options.retryable ?? false,
    ...(options.outcomeUnknown === undefined ? {} : { outcomeUnknown: options.outcomeUnknown }),
    details: { managedAuthCode: code },
  });
  if (options.cause !== undefined) (error as Error & { cause?: unknown }).cause = options.cause;
  return error;
}

function setCookieHeaders(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getter) return getter.call(headers);
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}
