import {
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesQuery,
  ListUserResourceAuthoritiesResponse,
  type OwnResource,
  type OwnResourceReachKind,
  OwnResourceReachQuery,
  OwnResourceReachResponse,
  type OwnResourceReachWorkspace,
  OwnResourcesResponse,
  RevokeUserResourceGrantQuery,
  SetOwnResourceReachRequest,
  SetOwnResourceReachResponse,
  UserResourceGrantMutationResponse,
  UserResourceGrantRevocationResponse,
} from "@opengeni/contracts";
import {
  getOwnResourceHere,
  issueManagedHumanUserResourceGrant,
  listManagedHumanUserResourceAuthorities,
  listOwnResourcesHere,
  nameOwnResources,
  OwnResourceAlwaysOnError,
  OwnResourceNotFoundError,
  ownResourceKey,
  requireAccessContext,
  requireAccessGrantAuthorization,
  revokeManagedHumanUserResourceGrant,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  SessionTenancyManagedHumanRequiredError,
  setOwnResourceHere,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type OwnResourceHere,
} from "@opengeni/core";
import {
  getWorkspace,
  nestedPostgresSqlState,
  SessionTenancyNotActivatedError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestBody, parseRequestQuery } from "../http/request-body";

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = parseRequestBody(schema, await context.req.json().catch(() => null), {
    status: 422,
    message: "invalid user-resource request",
  });
  return parsed;
}

function lifecycleError(error: unknown): never {
  if (error instanceof OwnResourceNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof OwnResourceAlwaysOnError) {
    throw new HTTPException(422, { message: error.message });
  }
  if (
    error instanceof SessionAuthorizationDeniedError ||
    error instanceof SessionTenancyManagedHumanRequiredError ||
    error instanceof SessionTenancyNotActivatedError
  ) {
    throw new HTTPException(403, { message: "user-resource authority denied" });
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    throw new HTTPException(503, { message: "session authorization unavailable" });
  }
  if (nestedPostgresSqlState(error) === "42501") {
    throw new HTTPException(403, { message: "user-resource authority denied" });
  }
  if (nestedPostgresSqlState(error) === "22023") {
    throw new HTTPException(422, { message: "invalid user-resource request" });
  }
  throw error;
}

function reachEntry(
  workspace: { id: string; name: string },
  here: OwnResourceHere,
  currentWorkspaceId: string,
): OwnResourceReachWorkspace {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    personal: here.personal,
    current: workspace.id === currentWorkspaceId,
    on: here.on,
    alwaysOn: here.alwaysOn,
    canChange: here.canChange,
  };
}

function byPersonalThenName(left: OwnResourceReachWorkspace, right: OwnResourceReachWorkspace) {
  return Number(right.personal) - Number(left.personal) || left.name.localeCompare(right.name);
}

type OwnWorkspaceRead<T> = { workspace: { id: string; name: string }; value: T };

/**
 * Read the same thing in each workspace you belong to in the asked-from
 * workspace's organization. The asked-from workspace must answer; a workspace
 * where you may not read it is left out.
 */
async function readInEachOwnWorkspace<T>(
  context: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  read: (authorization: AccessGrantAuthorization, workspaceId: string) => Promise<T>,
): Promise<{ here: AccessGrantAuthorization; reads: OwnWorkspaceRead<T>[] }> {
  const here = await requireAccessGrantAuthorization(context, deps, workspaceId, "workspace:read");
  const access = await requireAccessContext(context, deps);
  const candidates = new Set([
    workspaceId,
    ...access.workspaceGrants
      .filter((grant) => grant.accountId === here.grant.accountId)
      .map((grant) => grant.workspaceId),
  ]);
  const reads: OwnWorkspaceRead<T>[] = [];
  for (const candidate of candidates) {
    let value: T;
    try {
      const authorization =
        candidate === workspaceId
          ? here
          : await requireAccessGrantAuthorization(context, deps, candidate, "workspace:read");
      value = await read(authorization, candidate);
    } catch (error) {
      if (candidate === workspaceId) return lifecycleError(error);
      if (error instanceof HTTPException && [403, 404].includes(error.status)) continue;
      if (
        error instanceof SessionAuthorizationDeniedError ||
        error instanceof SessionTenancyManagedHumanRequiredError ||
        nestedPostgresSqlState(error) === "42501"
      )
        continue;
      throw error;
    }
    const workspace = await getWorkspace(deps.db, candidate);
    if (workspace) reads.push({ workspace, value });
  }
  return { here, reads };
}

const KIND_ORDER: Record<OwnResourceReachKind, number> = {
  connection: 0,
  subscription_connection: 1,
  connected_machine: 2,
};

const FALLBACK_NAME: Record<OwnResourceReachKind, string> = {
  connection: "Login",
  subscription_connection: "Model plan",
  connected_machine: "Machine",
};

/**
 * "Where it works" for your own login, plan or machine: each workspace you
 * belong to in the organization, and whether it works there for your own
 * messages. A workspace where you can't see it is left out. "My things"
 * reads all of them at once.
 */
function registerOwnResourceReachRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/own-resources", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const { here, reads } = await readInEachOwnWorkspace(
      context,
      deps,
      workspaceId,
      (authorization, at) => listOwnResourcesHere(deps, authorization, at),
    );
    const resources = new Map<
      string,
      Omit<OwnResource, "name" | "provider" | "plan"> & { originWorkspaceId: string | null }
    >();
    for (const { workspace, value } of reads) {
      for (const entry of value) {
        const key = ownResourceKey(entry);
        const resource = resources.get(key) ?? {
          resourceKind: entry.resourceKind,
          resourceId: entry.resourceId,
          originWorkspaceId: entry.originWorkspaceId,
          workspaces: [],
        };
        resource.workspaces.push(reachEntry(workspace, entry, workspaceId));
        resources.set(key, resource);
      }
    }
    let names: Awaited<ReturnType<typeof nameOwnResources>>;
    try {
      names = await nameOwnResources(deps, here, workspaceId, [...resources.values()]);
    } catch (error) {
      return lifecycleError(error);
    }
    const listed: OwnResource[] = [...resources.entries()].map(
      ([key, { originWorkspaceId: _origin, ...resource }]) => ({
        ...resource,
        name: names.get(key)?.name ?? FALLBACK_NAME[resource.resourceKind],
        provider: names.get(key)?.provider ?? null,
        plan: names.get(key)?.plan ?? null,
        workspaces: resource.workspaces.sort(byPersonalThenName),
      }),
    );
    listed.sort(
      (left, right) =>
        KIND_ORDER[left.resourceKind] - KIND_ORDER[right.resourceKind] ||
        left.name.localeCompare(right.name),
    );
    return context.json(OwnResourcesResponse.parse({ resources: listed }));
  });

  const path = "/v1/workspaces/:workspaceId/own-resources/reach";
  app.get(path, async (context) => {
    const query = parseRequestQuery(
      OwnResourceReachQuery,
      {
        resourceKind: context.req.query("resourceKind"),
        resourceId: context.req.query("resourceId"),
      },
      { status: 422, message: "resourceKind and resourceId are required" },
    );
    const workspaceId = context.req.param("workspaceId");
    const { reads } = await readInEachOwnWorkspace(
      context,
      deps,
      workspaceId,
      (authorization, at) => getOwnResourceHere(deps, authorization, at, query),
    );
    if (!reads.some(({ workspace, value }) => workspace.id === workspaceId && value)) {
      return lifecycleError(new OwnResourceNotFoundError());
    }
    const workspaces = reads
      .flatMap(({ workspace, value }) => (value ? [reachEntry(workspace, value, workspaceId)] : []))
      .sort(byPersonalThenName);
    return context.json(OwnResourceReachResponse.parse({ ...query, workspaces }));
  });

  app.put(path, async (context) => {
    const request = await body(context, SetOwnResourceReachRequest);
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      const here = await setOwnResourceHere(deps, access, workspaceId, request);
      const workspace = await getWorkspace(deps.db, workspaceId);
      if (!workspace) throw new HTTPException(404, { message: "workspace not found" });
      return context.json(
        SetOwnResourceReachResponse.parse({ workspace: reachEntry(workspace, here, workspaceId) }),
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return lifecycleError(error);
    }
  });
}

export function registerUserResourceAuthorityRoutes(app: Hono, deps: ApiRouteDeps): void {
  registerOwnResourceReachRoutes(app, deps);
  const base = "/v1/workspaces/:workspaceId/user-resource-authorities";
  app.get(base, async (context) => {
    const query = parseRequestQuery(
      ListUserResourceAuthoritiesQuery,
      {
        scope: context.req.query("scope"),
        resourceKind: context.req.query("resourceKind"),
        cursor: context.req.query("cursor"),
        limit: context.req.query("limit"),
      },
      { status: 422, message: "explicit scope=user required" },
    );
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      const page = await listManagedHumanUserResourceAuthorities(deps, access, workspaceId, query);
      return context.json(
        ListUserResourceAuthoritiesResponse.parse({
          scope: "user",
          ...page,
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.post(`${base}/:authorityId/grants`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorityId = z.string().uuid().safeParse(context.req.param("authorityId"));
    if (!authorityId.success) throw new HTTPException(422, { message: "invalid authority id" });
    const request = await body(context, IssueUserResourceGrantRequest);
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      return context.json(
        UserResourceGrantMutationResponse.parse({
          scope: "user",
          grant: await issueManagedHumanUserResourceGrant(
            deps,
            access,
            workspaceId,
            authorityId.data,
            request,
            "http",
          ),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.delete(`${base}/grants/:grantId`, async (context) => {
    parseRequestQuery(
      RevokeUserResourceGrantQuery,
      { scope: context.req.query("scope") },
      { status: 422, message: "explicit scope=user required" },
    );
    const grantId = z.string().uuid().safeParse(context.req.param("grantId"));
    if (!grantId.success) throw new HTTPException(422, { message: "invalid grant id" });
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      return context.json(
        UserResourceGrantRevocationResponse.parse({
          scope: "user",
          grant: await revokeManagedHumanUserResourceGrant(deps, access, workspaceId, grantId.data),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });
}
