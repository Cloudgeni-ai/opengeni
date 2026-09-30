import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ClearWorkspaceAllowanceRequest,
  GetMyUsageRequest,
  GetUsageRequest,
  GrantWorkspaceCreditsRequest,
  SetMemberAllowanceRequest,
  SetWorkspaceAllowanceRequest,
  WorkspaceAllowance,
  WorkspaceAllowanceState,
  WorkspaceCreditGrant,
  WorkspaceUsageResponse,
  MemberAllowance,
  ClearWorkspaceAllowanceResponse,
  type AccessContext,
} from "@opengeni/contracts";
import { ExternalIdentityReference } from "@opengeni/contracts/external-identities";
import {
  accountScopedApiKeyWorkspaceAuthority,
  accessGrantAuthorizationFromContext,
  requireAccountAdminAuthorizationStamp,
  requireAccessContext,
  requireAccessGrantAuthorization,
  requireResolvedAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  clearWorkspaceAllowance,
  findWorkspaceByExternalIdentity,
  getWorkspaceAllowance,
  getWorkspaceAllowanceState,
  getWorkspace,
  getWorkspaceUsage,
  grantWorkspaceCredits,
  nestedPostgresSqlState,
  setMemberAllowance,
  setWorkspaceAllowance,
  withAccountRls,
  UsageAllowanceVersionConflictError,
} from "@opengeni/db";
import { parseRequestBody, parseRequestJson } from "../http/request-body";

type Authority = { authorization: AccessGrantAuthorization; context: AccessContext };
type Operation = "read" | "budget-read" | "workspace-write" | "member-write" | "own";

/** No workspace wildcard, service initiator, or actor label can confer budget authority. */
export function requireAllowanceAuthority(
  { authorization, context }: Authority,
  operation: Operation,
): void {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  if (grant.principalKind === "agent_attempt" || grant.metadata?.sessionId !== undefined) {
    throw new HTTPException(403, { message: "Agents cannot access usage allowances" });
  }
  const organizationKey = accountScopedApiKeyWorkspaceAuthority(context);
  const sameOrganizationKey =
    organizationKey?.accountId === grant.accountId ? organizationKey : null;
  const accountAdmin =
    authorization.accountGrant?.permissions.includes("account:admin") === true &&
    requireAccountAdminAuthorizationStamp(authorization).accountId === grant.accountId;
  const workspaceAdmin = grant.permissions.includes("workspace:admin");
  if (operation === "own") {
    if (grant.principalKind !== "human_session" || grant.serviceInitiator) {
      throw new HTTPException(403, { message: "Own usage requires an authenticated member" });
    }
    return;
  }
  if (operation === "read" || operation === "budget-read") {
    if (
      workspaceAdmin ||
      accountAdmin ||
      sameOrganizationKey?.permissions.includes("workspace:read")
    )
      return;
  } else if (operation === "workspace-write") {
    // Match organization API-key control: full organization wildcard plus the
    // literal key-management permission. An asUser context carries no key stamp.
    if (sameOrganizationKey) {
      if (
        sameOrganizationKey.permissions.includes("workspace:admin") &&
        sameOrganizationKey.permissions.includes("api_keys:manage")
      )
        return;
    } else if (
      accountAdmin &&
      grant.principalKind === "human_session" &&
      !grant.serviceInitiator &&
      !context.subjectId.startsWith("api_key:")
    )
      return;
  } else if (operation === "member-write") {
    if (
      sameOrganizationKey?.permissions.includes("workspace:admin") ||
      (workspaceAdmin &&
        grant.principalKind === "human_session" &&
        !grant.serviceInitiator &&
        !context.subjectId.startsWith("api_key:"))
    )
      return;
  }
  throw new HTTPException(403, { message: `Missing usage allowance authority: ${operation}` });
}

async function resolveWorkspace(c: Context, deps: ApiRouteDeps): Promise<string> {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) return workspaceId;
  const context = await requireAccessContext(c, deps);
  const organizationKey = accountScopedApiKeyWorkspaceAuthority(context);
  // External tenant paths are host-service lookups, never caller-selected
  // default-account guesses or provisioning.
  const externalAccountId =
    c.req.header("x-opengeni-external-actor") !== undefined ? context.defaultAccountId : null;
  const accountId = organizationKey?.accountId ?? externalAccountId;
  if (!accountId)
    throw new HTTPException(403, { message: "Organization API key or external user required" });
  const reference = parseRequestBody(ExternalIdentityReference, {
    source: c.req.param("workspaceSource"),
    externalId: c.req.param("workspaceExternalId"),
  });
  const workspace = await withAccountRls(deps.db, accountId, (tx) =>
    findWorkspaceByExternalIdentity(tx, {
      accountId,
      externalSource: reference.source,
      externalId: reference.externalId,
    }),
  );
  if (!workspace) throw new HTTPException(404, { message: "Workspace not found" });
  return workspace.id;
}

async function authorize(c: Context, deps: ApiRouteDeps, operation: Operation) {
  const workspaceId = await resolveWorkspace(c, deps);
  const context = await requireAccessContext(c, deps);
  if (
    (operation === "workspace-write" || operation === "budget-read") &&
    !c.req.header("x-opengeni-external-actor") &&
    !context.subjectId.startsWith("api_key:")
  ) {
    // Organization budget management does not require membership in the
    // target shared workspace. Validate the existing authenticated account
    // authority on its own anchor, never manufacture a target workspace grant.
    for (const account of context.accountGrants) {
      if (account.subjectId !== context.subjectId || !account.permissions.includes("account:admin"))
        continue;
      const anchor = context.workspaceGrants.find(
        (grant) =>
          grant.accountId === account.accountId &&
          grant.subjectId === context.subjectId &&
          grant.principalKind === "human_session" &&
          !grant.serviceInitiator &&
          grant.metadata?.sessionId === undefined,
      );
      if (!anchor) continue;
      const stamp = requireAccountAdminAuthorizationStamp(
        accessGrantAuthorizationFromContext(context, anchor),
      );
      const target = await withAccountRls(deps.db, stamp.accountId, (tx) =>
        getWorkspace(tx, workspaceId),
      );
      if (!target || target.accountId !== stamp.accountId) continue;
      if (target.kind !== "shared") {
        throw new HTTPException(403, {
          message: "Organization budgets require a shared workspace",
        });
      }
      return {
        accountId: stamp.accountId,
        workspaceId,
        actorSubjectId: stamp.actorSubjectId,
        actorType: "human_session" as const,
      };
    }
    // An administrator of another organization may still hold an ordinary
    // target grant. A budget lookup miss grants nothing and must not mask it.
  }
  const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
  requireAllowanceAuthority({ authorization, context }, operation);
  return {
    accountId: authorization.grant.accountId,
    workspaceId,
    actorSubjectId: authorization.grant.subjectId,
    actorType: authorization.grant.principalKind ?? "subject",
  };
}

function usageQuery(c: Context, own: boolean) {
  const input = c.req.query();
  const parsed = parseRequestBody(own ? GetMyUsageRequest : GetUsageRequest, {
    ...input,
    ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
  });
  return {
    ...(parsed.period === undefined ? {} : { period: parsed.period }),
    ...("limit" in parsed && parsed.limit !== undefined ? { limit: parsed.limit as number } : {}),
    ...("cursor" in parsed && parsed.cursor !== undefined
      ? { cursor: parsed.cursor as string }
      : {}),
  };
}

function requireAllowanceProducersEnabled(deps: ApiRouteDeps): void {
  if (!deps.settings.usageAllowancesEnabled) {
    throw new HTTPException(409, {
      message:
        "Usage allowance changes are not enabled. Upgrade every API and worker before enabling usage allowances.",
    });
  }
}

/** Map lifecycle refusals without treating a failed CAS as an applied mutation. */
async function lifecycle<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UsageAllowanceVersionConflictError)
      throw new HTTPException(409, { message: error.message });
    const state = nestedPostgresSqlState(error);
    if (state === "40001" || state === "23505")
      throw new HTTPException(409, { message: "Allowance version or operation conflicts" });
    if (state === "42501")
      throw new HTTPException(403, { message: "Allowance operation is not authorized" });
    if (state === "P0002" || state === "23503")
      throw new HTTPException(404, { message: "Allowance or member not found" });
    if (state === "22023" || state === "23514")
      throw new HTTPException(400, { message: "Invalid allowance request" });
    throw error;
  }
}

export function registerUsageAllowanceRoutes(app: Hono, deps: ApiRouteDeps): void {
  const bases = [
    "/v1/workspaces/:workspaceId",
    "/v1/workspaces/external/:workspaceSource/:workspaceExternalId",
  ];
  for (const base of bases) {
    app.get(`${base}/allowance`, async (c) => {
      const scope = await authorize(c, deps, "budget-read");
      const result = await getWorkspaceAllowance(deps.db, scope);
      return c.json(result === null ? null : WorkspaceAllowance.parse(result));
    });
    app.get(`${base}/allowance/state`, async (c) => {
      const scope = await authorize(c, deps, "budget-read");
      return c.json(
        WorkspaceAllowanceState.parse(await getWorkspaceAllowanceState(deps.db, scope)),
      );
    });
    app.put(`${base}/allowance`, async (c) => {
      const scope = await authorize(c, deps, "workspace-write");
      const request = await parseRequestJson(c, SetWorkspaceAllowanceRequest);
      requireAllowanceProducersEnabled(deps);
      return c.json(
        WorkspaceAllowance.parse(
          await lifecycle(() =>
            setWorkspaceAllowance(deps.db, {
              ...scope,
              expectedVersion: request.expectedVersion,
              includedCredits: request.includedCredits,
              period: request.period,
              ...(request.anchorDay === undefined ? {} : { anchorDay: request.anchorDay }),
              ...(request.memberDefault === undefined
                ? {}
                : { memberDefault: request.memberDefault }),
              ...(request.thresholds === undefined
                ? {}
                : {
                    thresholds: {
                      ...(request.thresholds.workspace === undefined
                        ? {}
                        : { workspace: request.thresholds.workspace }),
                      ...(request.thresholds.member === undefined
                        ? {}
                        : { member: request.thresholds.member }),
                    },
                  }),
            }),
          ),
        ),
      );
    });
    app.delete(`${base}/allowance`, async (c) => {
      const scope = await authorize(c, deps, "workspace-write");
      const request = await parseRequestJson(c, ClearWorkspaceAllowanceRequest);
      return c.json(
        ClearWorkspaceAllowanceResponse.parse(
          await lifecycle(() =>
            clearWorkspaceAllowance(deps.db, {
              ...scope,
              expectedVersion: request.expectedVersion,
              ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
            }),
          ),
        ),
      );
    });
    app.post(`${base}/allowance/grants`, async (c) => {
      const scope = await authorize(c, deps, "workspace-write");
      const request = await parseRequestJson(c, GrantWorkspaceCreditsRequest);
      requireAllowanceProducersEnabled(deps);
      return c.json(
        WorkspaceCreditGrant.parse(
          await lifecycle(() =>
            grantWorkspaceCredits(deps.db, {
              ...scope,
              operationId: request.operationId,
              credits: request.credits,
              ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
            }),
          ),
        ),
      );
    });
    for (const memberPath of [
      "members/:subjectId",
      "members/external/:memberSource/:memberExternalId",
    ]) {
      app.put(`${base}/${memberPath}/allowance`, async (c) => {
        const scope = await authorize(c, deps, "member-write");
        const request = await parseRequestJson(c, SetMemberAllowanceRequest);
        if (request.rule !== null) requireAllowanceProducersEnabled(deps);
        const subjectId = c.req.param("subjectId");
        const target = subjectId
          ? { subjectId }
          : {
              externalIdentity: parseRequestBody(ExternalIdentityReference, {
                source: c.req.param("memberSource"),
                externalId: c.req.param("memberExternalId"),
              }),
            };
        // Resolve the exact external identity and live member inside the same
        // protected mutation; never enumerate a roster or provision an identity.
        return c.json(
          MemberAllowance.parse(
            await lifecycle(() => setMemberAllowance(deps.db, { ...scope, ...target, ...request })),
          ),
        );
      });
    }
    app.get(`${base}/usage`, async (c) => {
      const scope = await authorize(c, deps, "read");
      return c.json(
        WorkspaceUsageResponse.parse(
          await getWorkspaceUsage(deps.db, { ...scope, ...usageQuery(c, false) }),
        ),
      );
    });
    app.get(`${base}/usage/me`, async (c) => {
      const scope = await authorize(c, deps, "own");
      const result = WorkspaceUsageResponse.parse(
        await getWorkspaceUsage(deps.db, {
          ...scope,
          ...usageQuery(c, true),
          subjectId: scope.actorSubjectId,
        }),
      );
      // Defense in depth: the own endpoint never serializes another member or a
      // roster cursor even if the storage adapter returns an overbroad page.
      return c.json({
        ...result,
        members: result.members.filter((member) => member.subjectId === scope.actorSubjectId),
        nextCursor: null,
      });
    });
  }
}
