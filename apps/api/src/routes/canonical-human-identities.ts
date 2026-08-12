import { randomUUID } from "node:crypto";
import {
  CanonicalHumanBindingOperationRequest,
  CanonicalHumanIdentityMutationResponse,
  CanonicalHumanIdentityProjection,
  LinkCanonicalHumanLoginBindingRequest,
} from "@opengeni/contracts/canonical-human-identities";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  applyCanonicalHumanIdentityOperation,
  CanonicalHumanIdentityAuthorityError,
  CanonicalHumanIdentityConflictError,
  CanonicalHumanIdentityNotFoundError,
  CanonicalHumanIdentityOperationReuseError,
  getCanonicalHumanIdentityProjection,
} from "@opengeni/db/canonical-human-identities";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const BindingId = z.string().uuid();

async function requestIdentity(context: Context, deps: ApiRouteDeps) {
  return await requireCanonicalHumanRequestIdentity(context, {
    db: deps.db,
    ...(deps.managedAuth === undefined ? {} : { managedAuth: deps.managedAuth }),
    allowRecovery: true,
  });
}

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, { message: "Invalid canonical human identity request" });
  }
  return parsed.data;
}

function bindingId(context: Context): string {
  const parsed = BindingId.safeParse(context.req.param("bindingId"));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid login binding id" });
  return parsed.data;
}

function identityError(context: Context, error: unknown): Response {
  if (error instanceof CanonicalHumanIdentityConflictError) {
    return context.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof CanonicalHumanIdentityOperationReuseError) {
    return context.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof CanonicalHumanIdentityNotFoundError) {
    return context.json(
      { code: "CANONICAL_HUMAN_IDENTITY_NOT_FOUND", message: error.message },
      404,
    );
  }
  if (error instanceof CanonicalHumanIdentityAuthorityError) {
    return context.json(
      { code: "CANONICAL_HUMAN_IDENTITY_AUTHORITY_DENIED", message: error.message },
      403,
    );
  }
  throw error;
}

async function mutate(
  context: Context,
  deps: ApiRouteDeps,
  input: {
    operationType: "link" | "unlink" | "begin_recovery" | "recover";
    bindingId?: string;
    providerId?: string;
    providerAccountId?: string;
    operationId: string;
    expectedIdentityRevision: number;
    reason: string;
  },
): Promise<Response> {
  const identity = await requestIdentity(context, deps);
  try {
    return context.json(
      CanonicalHumanIdentityMutationResponse.parse(
        await applyCanonicalHumanIdentityOperation(deps.db, {
          operationId: input.operationId,
          authUserId: identity.authUserId,
          expectedIdentityRevision: input.expectedIdentityRevision,
          operationType: input.operationType,
          ...(input.bindingId ? { bindingId: input.bindingId } : {}),
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
          reason: input.reason,
        }),
      ),
    );
  } catch (error) {
    return identityError(context, error);
  }
}

export function registerCanonicalHumanIdentityRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/identity";

  app.get(base, async (context) => {
    const identity = await requestIdentity(context, deps);
    try {
      return context.json(
        CanonicalHumanIdentityProjection.parse(
          await getCanonicalHumanIdentityProjection(deps.db, identity.authUserId),
        ),
      );
    } catch (error) {
      return identityError(context, error);
    }
  });

  app.post(`${base}/login-bindings`, async (context) => {
    const request = await parseBody(context, LinkCanonicalHumanLoginBindingRequest);
    return await mutate(context, deps, {
      operationType: "link",
      ...request,
      operationId: request.operationId ?? randomUUID(),
    });
  });

  app.delete(`${base}/login-bindings/:bindingId`, async (context) => {
    const request = await parseBody(context, CanonicalHumanBindingOperationRequest);
    return await mutate(context, deps, {
      operationType: "unlink",
      bindingId: bindingId(context),
      ...request,
      operationId: request.operationId ?? randomUUID(),
    });
  });

  app.post(`${base}/login-bindings/:bindingId/recovery`, async (context) => {
    const request = await parseBody(context, CanonicalHumanBindingOperationRequest);
    return await mutate(context, deps, {
      operationType: "begin_recovery",
      bindingId: bindingId(context),
      ...request,
      operationId: request.operationId ?? randomUUID(),
    });
  });

  app.post(`${base}/login-bindings/:bindingId/recovery/complete`, async (context) => {
    const request = await parseBody(context, CanonicalHumanBindingOperationRequest);
    return await mutate(context, deps, {
      operationType: "recover",
      bindingId: bindingId(context),
      ...request,
      operationId: request.operationId ?? randomUUID(),
    });
  });
}
