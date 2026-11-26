import { StartAccountDeletionRequest } from "@opengeni/contracts";
import { getNativeAppManagedSession, type ApiRouteDeps } from "@opengeni/core";
import {
  getManagedAuthRequestActorLeaseStamp,
  markManagedAuthRequestActorTransitionApplied,
  requireCanonicalHumanRequestIdentity,
} from "@opengeni/core/canonical-human-identities";
import {
  accountDeletionAvailable,
  nestedPostgresSqlState,
  previewAccountDeletion,
  startAccountDeletion,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestBody, readRequestJson } from "../http/request-body";
import { dispatchAccountDeletion, runAccountDeletionStep } from "../account-deletion";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";

async function actor(c: Context, deps: ApiRouteDeps) {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const credential = authorization.startsWith("Bearer ogapp_") ? authorization.slice(7) : null;
    if (!deps.managedAuth || !credential) throw new HTTPException(401);
    const session = await getNativeAppManagedSession(deps.managedAuth, credential, deps.db);
    if (!session?.user || typeof session.session?.id !== "string") throw new HTTPException(401);
    return { authUserId: session.user.id, authSessionId: session.session.id };
  }
  if (c.req.method !== "GET") await admitManagedSignInMutation(c, deps);
  return requireCanonicalHumanRequestIdentity(c, {
    db: deps.db,
    managedAuth: deps.managedAuth,
    managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
    managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
}

async function requireAvailable(deps: ApiRouteDeps) {
  if (!deps.workflowClient.startAccountDeletion || !(await accountDeletionAvailable(deps.db))) {
    throw new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: "Account deletion is not available yet.",
      retryable: true,
      details: { code: "ACCOUNT_DELETION_UNAVAILABLE" },
    });
  }
}

export function registerAccountDeletionRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/me/account-deletion";
  app.get(path, async (c) => {
    c.header("cache-control", "no-store");
    const identity = await actor(c, deps);
    await requireAvailable(deps);
    try {
      return c.json(await previewAccountDeletion(deps.db, identity));
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501") throw new HTTPException(401);
      throw error;
    }
  });
  app.post(path, async (c) => {
    c.header("cache-control", "no-store");
    const identity = await actor(c, deps);
    const body = parseRequestBody(StartAccountDeletionRequest, await readRequestJson(c), {});
    await requireAvailable(deps);
    const lease = getManagedAuthRequestActorLeaseStamp(c.req.raw);
    const plan = await startAccountDeletion(deps.db, {
      ...identity,
      operationId: body.operationId,
      ...(lease ? { actorMutationRequestId: lease.requestId } : {}),
    }).catch((error: unknown) => {
      const state = nestedPostgresSqlState(error);
      if (state === "42501") throw new HTTPException(401);
      if (state === "55P03" || state === "40001") {
        throw new ApiHttpError(409, {
          code: "conflict",
          message: "Your account is busy. Wait a moment and try again.",
          retryable: true,
          details: { code: "ACCOUNT_DELETION_BUSY" },
        });
      }
      throw error;
    });
    if (!plan.request) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "Transfer ownership before deleting your account.",
        details: { code: "LAST_ORGANIZATION_OWNER", blockers: plan.blockers },
        retryable: false,
      });
    }
    markManagedAuthRequestActorTransitionApplied(c.req.raw);
    // The committed request is also a durable dispatch outbox. A lost Temporal
    // response or an API crash cannot undo admission or strand the request.
    void dispatchAccountDeletion(deps, plan.request.id).catch(() => undefined);
    return c.json({ request: plan.request }, 202);
  });

  // Exact request capability, not a browser, general API key, or agent tool.
  app.post("/_og/internal/account-deletion/:requestId", async (c) => {
    const requestId = z.uuid().safeParse(c.req.param("requestId"));
    const ticket = z
      .uuid()
      .safeParse(c.req.header("authorization")?.match(/^Bearer ([\w-]+)$/u)?.[1]);
    if (!requestId.success || !ticket.success) throw new HTTPException(404);
    const step = await runAccountDeletionStep(deps, {
      requestId: requestId.data,
      ticket: ticket.data,
    });
    if (!step) throw new HTTPException(404);
    return c.json(step);
  });
}
