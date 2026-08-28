import {
  AcceptOrganizationRecoveryCustodyRequest,
  ConfigureOrganizationRecoveryPolicyRequest,
  DisableOrganizationRecoveryPolicyRequest,
  OrganizationRecoveryMutationResponse,
  OrganizationRecoveryOperationCommandRequest,
  OrganizationRecoveryOverview,
  StartOrganizationRecoveryOperationRequest,
} from "@opengeni/contracts/organization-recovery";
import {
  getManagedAuthRequestActorAdmissionStamp,
  getManagedAuthRequestActorLeaseStamp,
  requireCanonicalHumanRequestIdentity,
} from "@opengeni/core/canonical-human-identities";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acceptOrganizationRecoveryCustody,
  approveOrganizationRecoveryOperation,
  cancelOrganizationRecoveryOperation,
  configureOrganizationRecoveryPolicy,
  disableOrganizationRecoveryPolicy,
  executeOrganizationRecoveryOperation,
  getOrganizationRecoveryOverview,
  OrganizationRecoveryDeniedError,
  OrganizationRecoveryOperationReuseError,
  OrganizationRecoveryRevisionConflictError,
  OrganizationRecoveryUnavailableError,
  startOrganizationRecoveryOperation,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";

const OrganizationId = z.string().uuid();
const RecoveryOperationId = z.string().uuid();

export type OrganizationRecoveryRouteServices = {
  requireCanonicalHumanRequestIdentity: typeof requireCanonicalHumanRequestIdentity;
  getManagedAuthRequestActorAdmissionStamp: typeof getManagedAuthRequestActorAdmissionStamp;
  getManagedAuthRequestActorLeaseStamp: typeof getManagedAuthRequestActorLeaseStamp;
  getOrganizationRecoveryOverview: typeof getOrganizationRecoveryOverview;
  configureOrganizationRecoveryPolicy: typeof configureOrganizationRecoveryPolicy;
  acceptOrganizationRecoveryCustody: typeof acceptOrganizationRecoveryCustody;
  disableOrganizationRecoveryPolicy: typeof disableOrganizationRecoveryPolicy;
  startOrganizationRecoveryOperation: typeof startOrganizationRecoveryOperation;
  approveOrganizationRecoveryOperation: typeof approveOrganizationRecoveryOperation;
  cancelOrganizationRecoveryOperation: typeof cancelOrganizationRecoveryOperation;
  executeOrganizationRecoveryOperation: typeof executeOrganizationRecoveryOperation;
};

const productionServices: OrganizationRecoveryRouteServices = {
  requireCanonicalHumanRequestIdentity,
  getManagedAuthRequestActorAdmissionStamp,
  getManagedAuthRequestActorLeaseStamp,
  getOrganizationRecoveryOverview,
  configureOrganizationRecoveryPolicy,
  acceptOrganizationRecoveryCustody,
  disableOrganizationRecoveryPolicy,
  startOrganizationRecoveryOperation,
  approveOrganizationRecoveryOperation,
  cancelOrganizationRecoveryOperation,
  executeOrganizationRecoveryOperation,
};

async function requireRecoveryIdentity(
  context: Context,
  deps: ApiRouteDeps,
  services: OrganizationRecoveryRouteServices,
) {
  // Recovery is a browser-session ceremony. Never let ambient API, bearer,
  // service, or machine authority become a competing recovery identity.
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !context.req.header("cookie") ||
    context.req.header("authorization")
  ) {
    throw new HTTPException(401, {
      message: "Managed human authentication required",
    });
  }
  const identity = await services.requireCanonicalHumanRequestIdentity(context, {
    db: deps.db,
    managedAuth: deps.managedAuth,
    managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
    managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
    allowRecovery: false,
  });
  return { ...identity, actorSubjectId: `user:${identity.authUserId}` };
}

async function parseBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: "Invalid organization recovery request",
    });
  }
  return parsed.data;
}

function parseId(schema: z.ZodString, value: string, label: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(422, { message: `Invalid ${label}` });
  return parsed.data;
}

function organizationId(context: Context): string {
  return parseId(OrganizationId, context.req.param("organizationId") ?? "", "organization id");
}

function recoveryOperationId(context: Context): string {
  return parseId(
    RecoveryOperationId,
    context.req.param("recoveryOperationId") ?? "",
    "recovery operation id",
  );
}

export function organizationRecoveryHttpError(error: unknown): Error {
  if (error instanceof OrganizationRecoveryRevisionConflictError) {
    return new ApiHttpError(409, {
      code: "conflict",
      message: "Recovery state changed; refresh before submitting a new action.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: error.code },
    });
  }
  if (error instanceof OrganizationRecoveryOperationReuseError) {
    return new ApiHttpError(409, {
      code: "idempotency_conflict",
      message: "Operation id was reused with different input.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: error.code },
    });
  }
  if (error instanceof OrganizationRecoveryUnavailableError) {
    return new ApiHttpError(409, {
      code: "conflict",
      message: "Organization recovery is unavailable.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: error.code },
    });
  }
  if (error instanceof OrganizationRecoveryDeniedError) {
    return new ApiHttpError(404, {
      code: "not_found",
      message: "Organization recovery not found.",
      retryable: false,
      outcomeUnknown: false,
    });
  }
  if (error instanceof Error) return error;
  return new Error("Organization recovery failed");
}

function requireActorFence(
  context: Context,
  deps: ApiRouteDeps,
  services: OrganizationRecoveryRouteServices,
) {
  const actorFence = services.getManagedAuthRequestActorLeaseStamp(context.req.raw);
  if (deps.settings.managedAuthSessionSetMode !== "legacy" && !actorFence) {
    throw new HTTPException(409, {
      message: "Managed actor mutation fence is unavailable",
    });
  }
  if (!actorFence) {
    throw new HTTPException(409, {
      message: "Organization recovery requires provider-neutral browser login slots",
    });
  }
  return actorFence;
}

async function mutationContext(
  context: Context,
  deps: ApiRouteDeps,
  services: OrganizationRecoveryRouteServices,
) {
  const identity = await requireRecoveryIdentity(context, deps, services);
  return {
    organizationId: organizationId(context),
    actorSubjectId: identity.actorSubjectId,
    actorAuthUserId: identity.authUserId,
    actorAuthSessionId: identity.authSessionId,
    actorFence: requireActorFence(context, deps, services),
  };
}

function mutationResponse(context: Context, value: unknown): Response {
  return context.json(OrganizationRecoveryMutationResponse.parse(value));
}

export function registerOrganizationRecoveryRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  services: OrganizationRecoveryRouteServices = productionServices,
): void {
  const base = "/v1/organizations/:organizationId/recovery";

  app.get(base, async (context) => {
    const identity = await requireRecoveryIdentity(context, deps, services);
    try {
      return context.json(
        OrganizationRecoveryOverview.parse(
          await services.getOrganizationRecoveryOverview(deps.db, {
            organizationId: organizationId(context),
            actorSubjectId: identity.actorSubjectId,
            actorAuthUserId: identity.authUserId,
            actorAuthSessionId: identity.authSessionId,
            actorFence: services.getManagedAuthRequestActorAdmissionStamp(context.req.raw) ?? null,
          }),
        ),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  });

  app.put(`${base}/policy`, async (context) => {
    const authority = await mutationContext(context, deps, services);
    const payload = await parseBody(context, ConfigureOrganizationRecoveryPolicyRequest);
    try {
      return mutationResponse(
        context,
        await services.configureOrganizationRecoveryPolicy(deps.db, {
          ...authority,
          operationId: payload.operationId,
          expectedPolicyRevision: payload.expectedPolicyRevision,
          custodianMembershipIds: payload.custodianMembershipIds,
        }),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  });

  app.post(`${base}/policy/accept`, async (context) => {
    const authority = await mutationContext(context, deps, services);
    const payload = await parseBody(context, AcceptOrganizationRecoveryCustodyRequest);
    try {
      return mutationResponse(
        context,
        await services.acceptOrganizationRecoveryCustody(deps.db, {
          ...authority,
          operationId: payload.operationId,
          expectedPolicyRevision: payload.expectedPolicyRevision,
        }),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  });

  app.post(`${base}/policy/disable`, async (context) => {
    const authority = await mutationContext(context, deps, services);
    const payload = await parseBody(context, DisableOrganizationRecoveryPolicyRequest);
    try {
      return mutationResponse(
        context,
        await services.disableOrganizationRecoveryPolicy(deps.db, {
          ...authority,
          operationId: payload.operationId,
          expectedPolicyRevision: payload.expectedPolicyRevision,
        }),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  });

  app.post(`${base}/operations`, async (context) => {
    const authority = await mutationContext(context, deps, services);
    const payload = await parseBody(context, StartOrganizationRecoveryOperationRequest);
    try {
      return mutationResponse(
        context,
        await services.startOrganizationRecoveryOperation(deps.db, {
          ...authority,
          operationId: payload.operationId,
          expectedPolicyRevision: payload.expectedPolicyRevision,
          targetMembershipId: payload.targetMembershipId,
        }),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  });

  async function mutateOperation(
    context: Context,
    command: typeof approveOrganizationRecoveryOperation,
  ): Promise<Response> {
    const authority = await mutationContext(context, deps, services);
    const payload = await parseBody(context, OrganizationRecoveryOperationCommandRequest);
    try {
      return mutationResponse(
        context,
        await command(deps.db, {
          ...authority,
          recoveryOperationId: recoveryOperationId(context),
          operationId: payload.operationId,
          expectedOperationRevision: payload.expectedOperationRevision,
        }),
      );
    } catch (error) {
      throw organizationRecoveryHttpError(error);
    }
  }

  app.post(`${base}/operations/:recoveryOperationId/approve`, async (context) =>
    mutateOperation(context, services.approveOrganizationRecoveryOperation),
  );
  app.post(`${base}/operations/:recoveryOperationId/cancel`, async (context) =>
    mutateOperation(context, services.cancelOrganizationRecoveryOperation),
  );
  app.post(`${base}/operations/:recoveryOperationId/execute`, async (context) =>
    mutateOperation(context, services.executeOrganizationRecoveryOperation),
  );
}
