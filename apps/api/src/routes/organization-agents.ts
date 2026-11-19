/**
 * Console agents API (organization agents, docs/agents.md "Console agents"):
 *
 * - `/v1/organizations/:organizationId/agents/...`: agents, versions,
 *   publishes, code deploys (`PUT by-key/:key/apply`), tool servers, the
 *   Console test workspace and test chats.
 * - `/v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey`:
 *   an end user's stored login for a tool server (write-only material).
 * - `GET /v1/workspaces/:workspaceId/organization-agents`: the published
 *   agents chats in a workspace can name, for the app's read-only view.
 *
 * Who may call (checked before every read and write; the database's
 * organization-agent visibility gate is not authorization):
 * - an organization API key of this organization holding the route's
 *   permission (`agents:read`, `agents:manage`, `tool_credentials:write`,
 *   plus `sessions:read` for chats and usage). Legacy full keys hold them
 *   through `workspace:admin`; a key limited to selected workspaces reads and
 *   names only those workspaces;
 * - the organization's owners and admins (organization administration),
 *   who have every permission here. Other members have none, as in Console.
 * - Changing who manages an agent (`POST .../management`) is for the
 *   organization's owner only; an API key is refused with
 *   `agent_management_requires_owner`.
 *
 * When Console agents are off for the organization
 * (OPENGENI_ORG_AGENTS_ACCOUNT_IDS), every route answers 404.
 */
import { environmentsEncryptionKeyBytes, orgAgentsEnabledForAccount } from "@opengeni/config";
import {
  ApplyOrgAgentRequest,
  ApplyOrgAgentResponse,
  ArchiveOrgAgentRequest,
  CreateOrgAgentRequest,
  CreateOrgAgentTestChatRequest,
  CreateOrgAgentTestChatResponse,
  CreateOrgToolServerRequest,
  EndUserToolCredentialResponse,
  ListOrgAgentPublishOperationsResponse,
  ListOrgAgentSessionsQuery,
  ListOrgAgentSessionsResponse,
  ListOrgAgentsResponse,
  ListOrgAgentVersionsResponse,
  ListOrgToolServersResponse,
  ListWorkspaceOrgAgentsResponse,
  OrgAgentDefinition,
  OrgAgentKey,
  OrgAgentMovableChatsResponse,
  OrgAgentResponse,
  OrgAgentTestWorkspaceResponse,
  OrgAgentUsageQuery,
  OrgAgentUsageResponse,
  OrgAgentVersionResponse,
  OrgToolServerKey,
  OrgToolServerResponse,
  OrgToolServerToolsResponse,
  PublishOrgAgentRequest,
  PublishOrgAgentResponse,
  PutEndUserToolCredentialRequest,
  SaveOrgAgentDraftRequest,
  SaveOrgAgentDraftResponse,
  SetOrgAgentManagementRequest,
  UpdateOrgAgentRequest,
  UpdateOrgToolServerRequest,
  type AccessContext,
  type ConsoleAccessLevel,
  type ErrorCode,
  type OrgAgentDefinition as OrgAgentDefinitionValue,
  type OrgAgentPublishOperation,
  type Permission,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  captureOrgAgentToolCatalog,
  hasPermission,
  listOrgToolServerToolsByKey,
  MissingPermissionRefusal,
  organizationWorkspaceInScope,
  requireAccessContext,
  requireAccessGrant,
  type AccountScopedApiKeyWorkspaceAuthority,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  allWorkspacePermissions,
  applyOrgAgent,
  archiveOrgAgent,
  ConsoleCursorError,
  countOrgAgentMovableChats,
  createOrgAgent,
  createOrgToolServer,
  createWorkspace,
  deleteEndUserToolCredential,
  deleteOrgToolServer,
  ensureExternalIdentity,
  ensureOrgAgentTestWorkspace,
  externalIdentityReadGranted,
  getConsoleReviewSettings,
  getEndUserToolCredential,
  getOrgAgent,
  getOrgAgentVersion,
  getOrgToolServer,
  grantWorkspaceAccess,
  insertWorkspaceMembershipIfAbsent,
  listOrgAgentChatWorkspaces,
  listOrgAgentPublishOperations,
  listOrgAgents,
  listOrgAgentSessions,
  listOrgAgentsForWorkspace,
  listOrgAgentVersions,
  listOrgToolServers,
  lockExternalWorkspaceMembershipLifecycle,
  lockExternalWorkspaceMembershipLifecycleShared,
  nestedPostgresSqlState,
  OrgAgentEncryptionUnavailableError,
  OrgAgentError,
  orgAgentUsage,
  publishOrgAgent,
  putEndUserToolCredential,
  readExternalIdentity,
  rlsContextForWorkspace,
  saveOrgAgentDraft,
  setOrgAgentManagement,
  updateOrgAgent,
  updateOrgToolServer,
  withAccountRls,
  WorkspaceLimitExceededError,
  WorkspaceNotFoundError,
  type Database,
  type OrgAgentActor,
} from "@opengeni/db";
import { configuredStaticUsageLimits } from "@opengeni/config";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson, parseRequestQuery } from "../http/request-body";
import {
  CONSOLE_ROLE_REQUIRED,
  consoleAccessCovers,
  consoleRoleRefusal,
  resolveConsoleAccess,
  type ConsoleAccess,
} from "./console-roles";

const Uuid = z.string().uuid();
const PositiveInt = z.coerce.number().int().positive();

/** Name of the organization's Console test workspace when Opengeni creates it. */
export const ORG_AGENT_TEST_WORKSPACE_NAME = "Console agent tests";
/** Header with a login used for one live tool list only (never stored). */
export const ORG_TOOL_LOGIN_HEADER = "x-opengeni-tool-login";

const STATUS_CODES: Record<number, ErrorCode> = {
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_failed",
  429: "limit_exceeded",
  503: "upstream_unavailable",
};

function httpError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ApiHttpError {
  return new ApiHttpError(status, {
    code: STATUS_CODES[status] ?? "internal_error",
    message,
    retryable: status === 503,
    details: { code, ...details },
  });
}

function agentNotFound(): ApiHttpError {
  return httpError(404, "agent_not_found", "Agent not found.");
}

/** Renders database refusals as the public error envelope. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OrgAgentError) {
      throw httpError(error.status, error.code, error.message, error.details);
    }
    if (error instanceof OrgAgentEncryptionUnavailableError) {
      throw httpError(503, "encryption_unavailable", error.message);
    }
    if (error instanceof ConsoleCursorError) {
      throw httpError(422, "invalid_cursor", "cursor is invalid");
    }
    throw error;
  }
}

type Caller = {
  organizationId: string;
  context: AccessContext;
  apiKey: AccountScopedApiKeyWorkspaceAuthority | null;
  /** A person's Console access (console-roles.ts); null for an API key. */
  access: Exclude<ConsoleAccessLevel, "none"> | null;
  actor: OrgAgentActor;
};

function uuidParam(c: Context, name: string): string {
  const parsed = Uuid.safeParse(c.req.param(name));
  if (!parsed.success) throw httpError(422, "validation_failed", `invalid ${name}`);
  return parsed.data.toLowerCase();
}

/**
 * The caller, after the flag (404 when off) and the permissions: an
 * organization key holding each of `permissions`, or a person whose Console
 * access covers `people` (console-roles.ts): owners and admins are full,
 * members have their Console role (Viewer, Editor or none). Each route names
 * both: what a key needs, and the least Console access a person needs.
 */
export async function authorizeOrgAgentsCaller(
  deps: Pick<ApiRouteDeps, "settings" | "db">,
  context: AccessContext,
  organizationId: string,
  permissions: readonly Permission[],
  people: ConsoleAccess,
): Promise<Caller> {
  if (!orgAgentsEnabledForAccount(deps.settings, organizationId)) throw agentNotFound();
  const apiKey = accountScopedApiKeyWorkspaceAuthority(context);
  const actor = { subjectId: context.subjectId, label: context.subjectLabel ?? null };
  if (apiKey) {
    if (apiKey.accountId !== organizationId) {
      throw new HTTPException(403, { message: "organization key is for another organization" });
    }
    for (const permission of permissions) {
      if (!hasPermission(apiKey.permissions, permission)) {
        throw new MissingPermissionRefusal(permission);
      }
    }
    return { organizationId, context, apiKey, access: null, actor };
  }
  const access = await resolveConsoleAccess(deps, context, organizationId);
  if (access === "none" || !consoleAccessCovers(access, people)) {
    throw consoleRoleRefusal(access === "none" ? "viewer" : people);
  }
  return { organizationId, context, apiKey: null, access, actor };
}

async function orgCaller(
  c: Context,
  deps: ApiRouteDeps,
  permissions: readonly Permission[],
  people: ConsoleAccess,
): Promise<Caller> {
  const organizationId = uuidParam(c, "organizationId");
  const context = await requireAccessContext(c, deps);
  return await authorizeOrgAgentsCaller(deps, context, organizationId, permissions, people);
}

/**
 * Editors change Console-managed agents only. Owners and admins (and keys,
 * by permission) go on to the agent's own rules, which refuse Console edits of
 * a code-managed agent for everyone.
 */
async function requireEditableByCaller(
  deps: ApiRouteDeps,
  caller: Caller,
  agentId: string,
): Promise<void> {
  if (caller.access !== "editor") return;
  const agent = await getOrgAgent(deps.db, caller.organizationId, { id: agentId });
  if (!agent) throw agentNotFound();
  if (agent.managedBy !== "console") {
    throw httpError(
      403,
      CONSOLE_ROLE_REQUIRED,
      "This agent is managed by code. Only organization owners and admins can switch it to Console.",
    );
  }
}

/** Only the organization's owner, as a person (never an API key). */
function requireOwner(caller: Caller): void {
  const grant = caller.context.accountGrants.find(
    (candidate) =>
      candidate.accountId === caller.organizationId &&
      candidate.subjectId === caller.context.subjectId,
  );
  if (caller.apiKey || grant?.role !== "owner") {
    throw httpError(
      403,
      "agent_management_requires_owner",
      "Only an organization owner can change who manages an agent.",
    );
  }
}

function inScope(caller: Caller, workspaceId: string): boolean {
  return !caller.apiKey || organizationWorkspaceInScope(caller.apiKey.workspaceScope, workspaceId);
}

function requireWorkspacesInScope(
  caller: Caller,
  workspaceIds: readonly string[] | undefined,
): void {
  for (const workspaceId of workspaceIds ?? []) {
    if (!inScope(caller, workspaceId)) {
      throw new HTTPException(403, { message: "workspace is outside organization key scope" });
    }
  }
}

async function toolCatalogFor(
  deps: ApiRouteDeps,
  organizationId: string,
  definition: OrgAgentDefinitionValue,
) {
  try {
    return await captureOrgAgentToolCatalog({
      db: deps.db,
      settings: deps.settings,
      accountId: organizationId,
      definition,
    });
  } catch {
    return null;
  }
}

/** Hands a `moveRunningChats` publish to the move workflow; without one it stays pending. */
async function startMove(
  deps: ApiRouteDeps,
  organizationId: string,
  operation: OrgAgentPublishOperation | null,
): Promise<void> {
  if (!operation || operation.status !== "pending" || !deps.orgAgentPublishMoveStarter) return;
  try {
    await deps.orgAgentPublishMoveStarter({
      accountId: organizationId,
      agentId: operation.agentId,
      operationId: operation.id,
    });
  } catch (error) {
    deps.observability?.warn("org agent publish move did not start", {
      operationId: operation.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function workspaceLimit(deps: ApiRouteDeps): number | null {
  if (deps.settings.usageLimitsMode !== "static" && deps.settings.usageLimitsMode !== "managed") {
    return null;
  }
  return configuredStaticUsageLimits(deps.settings).maxWorkspacesPerAccount ?? null;
}

async function ensureTestWorkspace(deps: ApiRouteDeps, caller: Caller) {
  try {
    const result = await ensureOrgAgentTestWorkspace(deps.db, {
      accountId: caller.organizationId,
      actor: caller.actor,
      create: (tx: Database) =>
        createWorkspace(tx, {
          accountId: caller.organizationId,
          name: ORG_AGENT_TEST_WORKSPACE_NAME,
          maxWorkspacesPerAccount: workspaceLimit(deps),
        }),
    });
    // People who test agents work in it as its owners; keys reach it through
    // their organization authority.
    if (!caller.apiKey) {
      const membership = {
        accountId: caller.organizationId,
        workspaceId: result.workspaceId,
        subjectId: caller.context.subjectId,
        role: "owner",
        permissions: allWorkspacePermissions,
      };
      if (result.created) {
        await grantWorkspaceAccess(deps.db, {
          ...membership,
          ...(caller.context.subjectLabel ? { subjectLabel: caller.context.subjectLabel } : {}),
        });
      } else {
        await insertWorkspaceMembershipIfAbsent(deps.db, membership);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof WorkspaceLimitExceededError) {
      throw httpError(429, "workspace_limit_reached", error.message);
    }
    throw error;
  }
}

/** `external_user:<id>` for an end user of the organization, provisioning it when asked. */
async function endUserSubjectId(
  deps: ApiRouteDeps,
  input: { accountId: string; externalId: string; source: string; provision: boolean },
): Promise<string | null> {
  const reference = { externalId: input.externalId, source: input.source };
  try {
    const known = await withAccountRls(deps.db, input.accountId, async (tx) => {
      if (!(await externalIdentityReadGranted(tx))) return undefined;
      await lockExternalWorkspaceMembershipLifecycleShared(tx, input.accountId);
      return await readExternalIdentity(tx, { accountId: input.accountId, ...reference });
    });
    if (known) return known.subjectId;
    // Not known yet (or the lock-free read is not granted on this database):
    // only a provisioning caller goes on.
    if (!input.provision) return null;
    const ensured = await withAccountRls(deps.db, input.accountId, async (tx) => {
      await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
      return await ensureExternalIdentity(tx, { accountId: input.accountId, ...reference });
    });
    return ensured.subjectId;
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") {
      throw httpError(403, "end_user_unavailable", "This end user is unavailable.");
    }
    if (error instanceof z.ZodError) {
      throw httpError(422, "validation_failed", "invalid external user id or source");
    }
    throw error;
  }
}

export function registerOrganizationAgentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/organizations/:organizationId/agents";
  const encryptionKey = () => environmentsEncryptionKeyBytes(deps.settings);

  // ---------------------------------------------------------------- tool servers

  app.get(`${base}/tool-servers`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const toolServers = await listOrgToolServers(deps.db, caller.organizationId);
    return c.json(ListOrgToolServersResponse.parse({ toolServers }));
  });

  app.post(`${base}/tool-servers`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const request = await parseRequestJson(c, CreateOrgToolServerRequest);
    const toolServer = await mapped(() =>
      createOrgToolServer(deps.db, {
        accountId: caller.organizationId,
        actor: caller.actor,
        request,
        encryptionKey: encryptionKey(),
      }),
    );
    return c.json(OrgToolServerResponse.parse({ toolServer }), 201);
  });

  function toolServerKey(c: Context): string {
    const parsed = OrgToolServerKey.safeParse(c.req.param("key"));
    if (!parsed.success) throw httpError(404, "tool_server_not_found", "Tool server not found.");
    return parsed.data;
  }

  app.get(`${base}/tool-servers/:key`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const toolServer = await getOrgToolServer(deps.db, caller.organizationId, toolServerKey(c));
    if (!toolServer) throw httpError(404, "tool_server_not_found", "Tool server not found.");
    return c.json(OrgToolServerResponse.parse({ toolServer }));
  });

  app.patch(`${base}/tool-servers/:key`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const key = toolServerKey(c);
    const request = await parseRequestJson(c, UpdateOrgToolServerRequest);
    const toolServer = await mapped(() =>
      updateOrgToolServer(deps.db, {
        accountId: caller.organizationId,
        key,
        actor: caller.actor,
        request,
        encryptionKey: encryptionKey(),
      }),
    );
    return c.json(OrgToolServerResponse.parse({ toolServer }));
  });

  app.delete(`${base}/tool-servers/:key`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const key = toolServerKey(c);
    const expected = c.req.query("expectedVersion");
    const expectedVersion = expected === undefined ? undefined : PositiveInt.safeParse(expected);
    if (expectedVersion && !expectedVersion.success) {
      throw httpError(422, "validation_failed", "invalid expectedVersion");
    }
    const deleted = await mapped(() =>
      deleteOrgToolServer(deps.db, {
        accountId: caller.organizationId,
        key,
        actor: caller.actor,
        ...(expectedVersion?.success ? { expectedVersion: expectedVersion.data } : {}),
      }),
    );
    if (!deleted) throw httpError(404, "tool_server_not_found", "Tool server not found.");
    return c.body(null, 204);
  });

  app.get(`${base}/tool-servers/:key/tools`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const login = c.req.header(ORG_TOOL_LOGIN_HEADER)?.trim() || null;
    const tools = await listOrgToolServerToolsByKey({
      db: deps.db,
      settings: deps.settings,
      accountId: caller.organizationId,
      key: toolServerKey(c),
      login: login ? login.replace(/^Bearer\s+/i, "") : null,
    });
    if (!tools) throw httpError(404, "tool_server_not_found", "Tool server not found.");
    return c.json(OrgToolServerToolsResponse.parse(tools));
  });

  // ---------------------------------------------------------------- test workspace

  app.post(`${base}/test-workspace`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const result = await ensureTestWorkspace(deps, caller);
    return c.json(OrgAgentTestWorkspaceResponse.parse(result), result.created ? 201 : 200);
  });

  // ---------------------------------------------------------------- agents

  app.get(base, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const agents = await listOrgAgents(deps.db, caller.organizationId, {
      includeArchived: c.req.query("includeArchived") === "true",
    });
    return c.json(ListOrgAgentsResponse.parse({ agents }));
  });

  app.post(base, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const request = CreateOrgAgentRequest.parse(await parseRequestJson(c, CreateOrgAgentRequest));
    requireWorkspacesInScope(caller, request.workspaceIds);
    // Which team workspaces an agent is available in is for owners and admins.
    if (caller.access === "editor" && (request.workspaceIds?.length ?? 0) > 0) {
      throw consoleRoleRefusal("full");
    }
    const definition = OrgAgentDefinition.parse({
      name: request.name,
      description: request.description ?? "",
      instructions: request.instructions ?? "",
      ...(request.config ? { config: request.config } : {}),
    });
    const toolCatalog = await toolCatalogFor(deps, caller.organizationId, definition);
    const agent = await mapped(() =>
      createOrgAgent(deps.db, {
        accountId: caller.organizationId,
        actor: caller.actor,
        key: request.key,
        definition,
        workspaceIds: request.workspaceIds ?? [],
        toolCatalog,
      }),
    );
    return c.json(OrgAgentResponse.parse({ agent }), 201);
  });

  function agentKey(c: Context): string {
    const parsed = OrgAgentKey.safeParse(c.req.param("key"));
    if (!parsed.success) throw agentNotFound();
    return parsed.data;
  }

  app.get(`${base}/by-key/:key`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const agent = await getOrgAgent(
      deps.db,
      caller.organizationId,
      { key: agentKey(c) },
      { includeArchived: c.req.query("includeArchived") === "true" },
    );
    if (!agent) throw agentNotFound();
    return c.json(OrgAgentResponse.parse({ agent }));
  });

  app.put(`${base}/by-key/:key/apply`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const key = agentKey(c);
    const request = ApplyOrgAgentRequest.parse(await parseRequestJson(c, ApplyOrgAgentRequest));
    const { publish, moveRunningChats, dryRun, expectedVersion, ...rest } = request;
    const definition = OrgAgentDefinition.parse(rest);
    const toolCatalog = dryRun
      ? null
      : await toolCatalogFor(deps, caller.organizationId, definition);
    const result = await mapped(() =>
      applyOrgAgent(deps.db, {
        accountId: caller.organizationId,
        key,
        actor: caller.actor,
        definition,
        publish,
        moveRunningChats,
        dryRun,
        expectedVersion,
        toolCatalog,
      }),
    );
    await startMove(deps, caller.organizationId, result.operation);
    return c.json(
      ApplyOrgAgentResponse.parse(result),
      result.outcome === "created" && !dryRun ? 201 : 200,
    );
  });

  app.get(`${base}/:agentId`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const agent = await getOrgAgent(
      deps.db,
      caller.organizationId,
      { id: uuidParam(c, "agentId") },
      { includeArchived: c.req.query("includeArchived") === "true" },
    );
    if (!agent) throw agentNotFound();
    return c.json(OrgAgentResponse.parse({ agent }));
  });

  app.patch(`${base}/:agentId`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const agentId = uuidParam(c, "agentId");
    const request = UpdateOrgAgentRequest.parse(await parseRequestJson(c, UpdateOrgAgentRequest));
    requireWorkspacesInScope(caller, request.workspaceIds);
    const agent = await mapped(() =>
      updateOrgAgent(deps.db, {
        accountId: caller.organizationId,
        agentId,
        actor: caller.actor,
        expectedVersion: request.expectedVersion,
        ...(request.workspaceIds !== undefined ? { workspaceIds: request.workspaceIds } : {}),
      }),
    );
    return c.json(OrgAgentResponse.parse({ agent }));
  });

  app.put(`${base}/:agentId/draft`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const agentId = uuidParam(c, "agentId");
    await requireEditableByCaller(deps, caller, agentId);
    const request = SaveOrgAgentDraftRequest.parse(
      await parseRequestJson(c, SaveOrgAgentDraftRequest),
    );
    const { expectedVersion, ...rest } = request;
    const definition = OrgAgentDefinition.parse(rest);
    const toolCatalog = await toolCatalogFor(deps, caller.organizationId, definition);
    const result = await mapped(() =>
      saveOrgAgentDraft(deps.db, {
        accountId: caller.organizationId,
        agentId,
        actor: caller.actor,
        expectedVersion,
        definition,
        toolCatalog,
      }),
    );
    return c.json(SaveOrgAgentDraftResponse.parse(result), result.created ? 201 : 200);
  });

  app.get(`${base}/:agentId/versions`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const versions = await listOrgAgentVersions(
      deps.db,
      caller.organizationId,
      uuidParam(c, "agentId"),
    );
    if (!versions) throw agentNotFound();
    return c.json(ListOrgAgentVersionsResponse.parse({ versions }));
  });

  app.get(`${base}/:agentId/versions/:version`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const agentId = uuidParam(c, "agentId");
    const version = PositiveInt.safeParse(c.req.param("version"));
    if (!version.success) throw httpError(404, "agent_version_not_found", "Version not found.");
    const found = await getOrgAgentVersion(deps.db, caller.organizationId, agentId, version.data);
    if (!found) throw httpError(404, "agent_version_not_found", "Version not found.");
    return c.json(OrgAgentVersionResponse.parse({ version: found }));
  });

  app.post(`${base}/:agentId/publish`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const agentId = uuidParam(c, "agentId");
    await requireEditableByCaller(deps, caller, agentId);
    const request = PublishOrgAgentRequest.parse(await parseRequestJson(c, PublishOrgAgentRequest));
    const result = await mapped(() =>
      publishOrgAgent(deps.db, {
        accountId: caller.organizationId,
        agentId,
        actor: caller.actor,
        version: request.version,
        moveRunningChats: request.moveRunningChats,
        expectedVersion: request.expectedVersion,
      }),
    );
    await startMove(deps, caller.organizationId, result.operation);
    return c.json(PublishOrgAgentResponse.parse(result));
  });

  app.get(`${base}/:agentId/publish-operations`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const operations = await listOrgAgentPublishOperations(
      deps.db,
      caller.organizationId,
      uuidParam(c, "agentId"),
    );
    if (!operations) throw agentNotFound();
    return c.json(ListOrgAgentPublishOperationsResponse.parse({ operations }));
  });

  /** The organization's workspaces this caller may read an agent's chats in. */
  async function chatWorkspaces(caller: Caller, agentId: string, includeAccess: boolean) {
    const { managed, access } = await listOrgAgentChatWorkspaces(deps.db, {
      accountId: caller.organizationId,
      agentId,
    });
    const all = includeAccess ? [...new Set([...managed, ...access])] : managed;
    return all.filter((workspaceId) => inScope(caller, workspaceId));
  }

  async function requireAgent(caller: Caller, agentId: string): Promise<void> {
    const agent = await getOrgAgent(
      deps.db,
      caller.organizationId,
      { id: agentId },
      {
        includeArchived: true,
      },
    );
    if (!agent) throw agentNotFound();
  }

  app.get(`${base}/:agentId/movable-chats`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const agentId = uuidParam(c, "agentId");
    const version = PositiveInt.safeParse(c.req.query("version"));
    if (!version.success) throw httpError(422, "validation_failed", "version is required");
    await requireAgent(caller, agentId);
    const count = await countOrgAgentMovableChats(deps.db, {
      accountId: caller.organizationId,
      agentId,
      toVersion: version.data,
      workspaceIds: await chatWorkspaces(caller, agentId, true),
    });
    return c.json(OrgAgentMovableChatsResponse.parse({ count }));
  });

  app.post(`${base}/:agentId/management`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    requireOwner(caller);
    const agentId = uuidParam(c, "agentId");
    const request = SetOrgAgentManagementRequest.parse(
      await parseRequestJson(c, SetOrgAgentManagementRequest),
    );
    const agent = await mapped(() =>
      setOrgAgentManagement(deps.db, {
        accountId: caller.organizationId,
        agentId,
        actor: caller.actor,
        managedBy: request.managedBy,
        expectedVersion: request.expectedVersion,
      }),
    );
    return c.json(OrgAgentResponse.parse({ agent }));
  });

  app.post(`${base}/:agentId/archive`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const agentId = uuidParam(c, "agentId");
    const request = ArchiveOrgAgentRequest.parse(await parseRequestJson(c, ArchiveOrgAgentRequest));
    const agent = await mapped(() =>
      archiveOrgAgent(deps.db, {
        accountId: caller.organizationId,
        agentId,
        actor: caller.actor,
        expectedVersion: request.expectedVersion,
      }),
    );
    return c.json(OrgAgentResponse.parse({ agent }));
  });

  app.get(`${base}/:agentId/sessions`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read", "sessions:read"], "viewer");
    const agentId = uuidParam(c, "agentId");
    const query = parseRequestQuery(ListOrgAgentSessionsQuery, c.req.query(), {
      status: 422,
      message: "invalid agent session list query",
    });
    await requireAgent(caller, agentId);
    // The Console review level applies to every reader, keys included.
    const { reviewLevel } = await getConsoleReviewSettings(deps.db, caller.organizationId);
    if (reviewLevel === "off") {
      throw httpError(403, "session_review_off", "Session review is off for this organization");
    }
    const workspaceIds = await chatWorkspaces(caller, agentId, false);
    const page = await mapped(() =>
      listOrgAgentSessions(deps.db, {
        accountId: caller.organizationId,
        agentId,
        workspaceIds,
        limit: query.limit,
        cursor: query.cursor ?? null,
        version: query.version,
        includeContent: reviewLevel === "full",
      }),
    );
    return c.json(ListOrgAgentSessionsResponse.parse(page));
  });

  app.get(`${base}/:agentId/usage`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read", "sessions:read"], "viewer");
    const agentId = uuidParam(c, "agentId");
    const query = parseRequestQuery(OrgAgentUsageQuery, c.req.query(), {
      status: 422,
      message: "invalid agent usage query",
    });
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (!(from < to) || to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw httpError(422, "validation_failed", "from must be before to, at most 366 days apart");
    }
    await requireAgent(caller, agentId);
    const usage = await orgAgentUsage(deps.db, {
      accountId: caller.organizationId,
      agentId,
      workspaceIds: await chatWorkspaces(caller, agentId, true),
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return c.json(OrgAgentUsageResponse.parse(usage));
  });

  app.post(`${base}/:agentId/test-chats`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const agentId = uuidParam(c, "agentId");
    const request = CreateOrgAgentTestChatRequest.parse(
      await parseRequestJson(c, CreateOrgAgentTestChatRequest),
    );
    const version = await getOrgAgentVersion(
      deps.db,
      caller.organizationId,
      agentId,
      request.version,
    );
    if (!version) {
      const agent = await getOrgAgent(deps.db, caller.organizationId, { id: agentId });
      if (!agent) throw agentNotFound();
      throw httpError(404, "agent_version_not_found", `Version ${request.version} does not exist.`);
    }
    const { workspaceId } = await ensureTestWorkspace(deps, caller);
    if (!inScope(caller, workspaceId)) {
      throw new HTTPException(403, { message: "workspace is outside organization key scope" });
    }
    // Through the ordinary session create, as the caller, so every create
    // rule (credits, models, limits, organization agent resolution) applies.
    const logins = Object.entries(request.toolLogins ?? {});
    const body = {
      initialMessage: request.message,
      agent: {
        ref: agentId,
        version: request.version,
        ...(logins.length > 0
          ? {
              toolServers: logins.map(([server, token]) => ({
                server,
                headers: { Authorization: `Bearer ${token}` },
              })),
            }
          : {}),
      },
    };
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const url = new URL(`/v1/workspaces/${workspaceId}/sessions`, c.req.url);
    const response = await app.request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) return response;
    const created = (await response.json()) as { id?: unknown };
    if (typeof created.id !== "string") {
      throw new HTTPException(502, { message: "session create returned no id" });
    }
    return c.json(
      CreateOrgAgentTestChatResponse.parse({ workspaceId, sessionId: created.id }),
      201,
    );
  });

  // ---------------------------------------------------------------- workspaces

  app.get("/v1/workspaces/:workspaceId/organization-agents", async (c) => {
    const workspaceId = uuidParam(c, "workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    if (!orgAgentsEnabledForAccount(deps.settings, grant.accountId)) {
      return c.json(ListWorkspaceOrgAgentsResponse.parse({ agents: [] }));
    }
    const agents = await listOrgAgentsForWorkspace(deps.db, {
      accountId: grant.accountId,
      workspaceId,
    });
    return c.json(ListWorkspaceOrgAgentsResponse.parse({ agents }));
  });

  const credentialPath =
    "/v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey";

  async function credentialTarget(c: Context, permission: Permission, provision: boolean) {
    const workspaceId = uuidParam(c, "workspaceId");
    const context = await requireAccessContext(c, deps);
    let accountId: string;
    const workspaceNotFound = () => new HTTPException(404, { message: "workspace not found" });
    try {
      accountId = (await rlsContextForWorkspace(deps.db, workspaceId)).accountId;
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) throw workspaceNotFound();
      throw error;
    }
    // Callers outside the organization learn nothing about its workspaces.
    const apiKey = accountScopedApiKeyWorkspaceAuthority(context);
    const related = apiKey
      ? apiKey.accountId === accountId
      : context.accountGrants.some((grant) => grant.accountId === accountId);
    if (!related) throw workspaceNotFound();
    // Stored logins are for owners and admins among people (keys by permission).
    const caller = await authorizeOrgAgentsCaller(deps, context, accountId, [permission], "full");
    if (!inScope(caller, workspaceId)) {
      throw new HTTPException(403, { message: "workspace is outside organization key scope" });
    }
    const key = OrgToolServerKey.safeParse(c.req.param("toolServerKey"));
    if (!key.success) throw httpError(404, "tool_server_not_found", "Tool server not found.");
    const externalId = c.req.param("externalUserId") ?? "";
    const subjectId = await endUserSubjectId(deps, {
      accountId,
      externalId,
      source: c.req.query("source") ?? "default",
      // Only an organization key provisions an end user, as on authentication.
      provision: provision && caller.apiKey !== null,
    });
    return { caller, accountId, workspaceId, subjectId, toolServerKey: key.data };
  }

  app.put(credentialPath, async (c) => {
    const target = await credentialTarget(c, "tool_credentials:write", true);
    if (!target.subjectId) throw httpError(404, "end_user_not_found", "End user not found.");
    const credential = await parseRequestJson(c, PutEndUserToolCredentialRequest);
    const stored = await mapped(() =>
      putEndUserToolCredential(deps.db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        endUserSubjectId: target.subjectId!,
        toolServerKey: target.toolServerKey,
        actor: target.caller.actor,
        credential,
        encryptionKey: encryptionKey(),
      }),
    );
    return c.json(EndUserToolCredentialResponse.parse({ credential: stored }));
  });

  app.get(credentialPath, async (c) => {
    const target = await credentialTarget(c, "agents:read", false);
    const notFound = () => httpError(404, "tool_credential_not_found", "No stored login.");
    if (!target.subjectId) throw notFound();
    const credential = await mapped(() =>
      getEndUserToolCredential(deps.db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        endUserSubjectId: target.subjectId!,
        toolServerKey: target.toolServerKey,
      }),
    );
    if (!credential) throw notFound();
    return c.json(EndUserToolCredentialResponse.parse({ credential }));
  });

  app.delete(credentialPath, async (c) => {
    const target = await credentialTarget(c, "tool_credentials:write", false);
    const notFound = () => httpError(404, "tool_credential_not_found", "No stored login.");
    if (!target.subjectId) throw notFound();
    const deleted = await mapped(() =>
      deleteEndUserToolCredential(deps.db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        endUserSubjectId: target.subjectId!,
        toolServerKey: target.toolServerKey,
        actor: target.caller.actor,
      }),
    );
    if (!deleted) throw notFound();
    return c.body(null, 204);
  });
}
