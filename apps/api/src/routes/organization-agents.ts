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
 *   names only those workspaces, and cannot write tool servers or publish
 *   with `moveRunningChats` (403 `organization_key_workspace_limited`): both
 *   reach every workspace;
 * - people, by Console role (`./console-roles.ts`, docs/opengeni-console.md
 *   "Roles"): owners and admins (`full`) may do everything here except what
 *   is owner-only; an Editor reads, creates agents (without team workspace
 *   availability), saves drafts of and publishes or rolls back
 *   Console-managed agents, and runs test chats; a Viewer reads agents,
 *   versions, tool servers, publish operations and an agent's chats and
 *   usage. Tool server writes, code deploys (`apply`), team workspace
 *   availability, archiving and end users' tool logins are for owners and
 *   admins. Members without a Console role, and agents or personal keys
 *   acting for a person, are refused with 403 `console_role_required`.
 * - Changing who manages an agent (`POST .../management`) is for the
 *   organization's owner only; an API key is refused with
 *   `agent_management_requires_owner`.
 * - Test chats run in the Console test workspace as the tester's own test
 *   chat principal (`consoleTestChatGrant`); nobody becomes a member there.
 *   `GET .../test-chats/:sessionId[/events]` and `POST .../messages` serve
 *   only the caller's own test chats (Editor or more, or the key that
 *   started them); everyone else gets 404 `test_chat_not_found`.
 *
 * When Console agents are off for the organization
 * (OPENGENI_ORG_AGENTS_ACCOUNT_IDS), every route answers 404.
 */
import { environmentsEncryptionKeyBytes, orgAgentsEnabledForAccount } from "@opengeni/config";
import {
  ApplyOrgAgentRequest,
  ApplyOrgAgentResponse,
  ArchiveOrgAgentRequest,
  ControlOrgAgentTestChatRequest,
  ControlOrgAgentTestChatResponse,
  CreateOrgAgentRequest,
  CONSOLE_TEST_CHAT_SUBJECT_PREFIX,
  CreateOrgAgentTestChatRequest,
  CreateOrgAgentTestChatResponse,
  CreateOrgToolServerRequest,
  DecideOrgAgentTestChatApprovalRequest,
  EndUserToolCredentialResponse,
  ListOrgAgentComputeResponse,
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
  OrgAgentTestChatEventsQuery,
  OrgAgentTestChatResponse,
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
  SendOrgAgentTestChatMessageRequest,
  SESSION_EVENT_RAW_DELTA_TYPES,
  SetOrgAgentManagementRequest,
  UpdateOrgAgentRequest,
  UpdateOrgToolServerRequest,
  type AccessContext,
  type AccessGrant,
  type ConsoleAccessLevel,
  type ErrorCode,
  type OrgAgentDefinition as OrgAgentDefinitionValue,
  type OrgAgentPublishOperation,
  type Permission,
} from "@opengeni/contracts";
import {
  acceptSessionUserMessage,
  accountScopedApiKeyWorkspaceAuthority,
  captureOrgAgentToolCatalog,
  controlHumanSessionWorkstream,
  createSessionForRequestWithOutcome,
  hasPermission,
  listOrgToolServerToolsByKey,
  MissingPermissionRefusal,
  organizationWorkspaceInScope,
  requireAccessContext,
  requireAccessGrant,
  resolveWorkspaceCatalogSettings,
  workflowIdForSession,
  type AccountScopedApiKeyWorkspaceAuthority,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  acceptSessionApprovalDecision,
  applyOrgAgent,
  archiveOrgAgent,
  computeReachIncludesManagedWorkspaces,
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
  failPendingOrgAgentPublishOperation,
  findOrgAgentTestWorkspace,
  getConsoleReviewSettings,
  recordConsoleAuditEvent,
  getEndUserToolCredential,
  getOrgAgent,
  getOrgAgentVersion,
  getOrgToolServer,
  getSession,
  getSessionCreator,
  listOrgAgentChatWorkspaces,
  listOrgAgentCompute,
  listOrgAgentPublishOperations,
  listOrgAgents,
  listOrgAgentSessions,
  listOrgAgentsForWorkspace,
  listOrgAgentVersions,
  listOrgToolServers,
  listSessionEventPage,
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
  SessionApprovalAnswerError,
  setOrgAgentManagement,
  updateOrgAgent,
  updateOrgToolServer,
  withAccountRls,
  WorkspaceLimitExceededError,
  withConsoleSessionRead,
  WorkspaceNotFoundError,
  type Database,
  type OrgAgentActor,
  type OrgAgentPublishMoveFailure,
} from "@opengeni/db";
import { configuredStaticUsageLimits } from "@opengeni/config";
import { sha256Hex } from "@opengeni/contracts/values";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordAcceptedApiAdmission } from "../admission-trace";
import { ApiHttpError, approvalForbiddenHttpError } from "../http/api-error";
import { parseRequestJson, parseRequestQuery } from "../http/request-body";
import { measureSessionCreatePhase } from "../session-create-observability";
import {
  CONSOLE_ROLE_REQUIRED,
  consoleAccessCovers,
  consoleRoleRefusal,
  resolveConsoleAccess,
  type ConsoleAccess,
} from "./console-roles";
import { commandConflictResponse, sessionCreateErrorResponse } from "./sessions";

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
 * An agent made available in team workspaces runs there too, so changing or
 * publishing it is for owners and admins: Editors get 403
 * `agent_in_team_workspaces`.
 * This read runs before the write's transaction, but draft and publish both
 * require `expectedVersion`, and adding team workspaces bumps the agent's row
 * version: an admin change landing after this check makes the write fail
 * with `agent_version_conflict` instead.
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
  if (agent.workspaceIds.length > 0) {
    throw httpError(
      403,
      "agent_in_team_workspaces",
      "This agent is available in team workspaces. Only organization owners and admins can change or publish it.",
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

/**
 * Tool server writes and moving running chats reach every workspace of the
 * organization, so an organization key limited to selected workspaces is
 * refused (people are covered by their Console role).
 */
function requireAllWorkspacesKey(caller: Caller, change: string): void {
  if (caller.apiKey && caller.apiKey.workspaceScope.kind !== "all") {
    throw httpError(
      403,
      "organization_key_workspace_limited",
      `${change} reaches every workspace of the organization. Use an organization key for all workspaces.`,
    );
  }
}

function inScope(caller: Caller, workspaceId: string): boolean {
  return !caller.apiKey || organizationWorkspaceInScope(caller.apiKey.workspaceScope, workspaceId);
}

/** Whether the caller is an organization key limited to selected workspaces. */
function workspaceLimited(caller: Caller): boolean {
  return !!caller.apiKey && caller.apiKey.workspaceScope.kind !== "all";
}

/**
 * An agent as the caller may see it: a workspace-limited organization key
 * sees only the workspaces in its scope in `workspaceIds`.
 */
function agentForCaller<T extends { workspaceIds: string[] } | null | undefined>(
  caller: Caller,
  agent: T,
): T {
  if (!agent || !workspaceLimited(caller)) return agent;
  return {
    ...agent,
    workspaceIds: agent.workspaceIds.filter((workspaceId) => inScope(caller, workspaceId)),
  };
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

/**
 * Hands a `moveRunningChats` publish to the move workflow. When this
 * deployment has none, or it cannot be started, the operation is marked
 * `failed` with `failureReason` (the version stays published; publish again
 * to retry) instead of staying `pending`. Returns the operation as it is now.
 * With `keepPendingOnError` (the re-drive from a read), a start that throws
 * leaves the operation `pending` for a later try instead.
 */
async function startMove(
  deps: ApiRouteDeps,
  organizationId: string,
  operation: OrgAgentPublishOperation | null,
  options: { keepPendingOnError?: boolean } = {},
): Promise<OrgAgentPublishOperation | null> {
  if (!operation || operation.status !== "pending") return operation;
  let reason: OrgAgentPublishMoveFailure = "move_unavailable";
  if (deps.orgAgentPublishMoveStarter) {
    try {
      await deps.orgAgentPublishMoveStarter({
        accountId: organizationId,
        agentId: operation.agentId,
        operationId: operation.id,
      });
      return operation;
    } catch (error) {
      deps.observability?.warn("org agent publish move did not start", {
        operationId: operation.id,
        keptPending: options.keepPendingOnError === true,
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.keepPendingOnError) return operation;
      reason = "move_start_failed";
    }
  }
  return (
    (await failPendingOrgAgentPublishOperation(deps.db, {
      accountId: organizationId,
      operationId: operation.id,
      reason,
    })) ?? operation
  );
}

/** A `pending` move older than this was left behind by an API that stopped before starting it. */
const STALE_PENDING_MOVE_MS = 2 * 60_000;

/**
 * Re-drives moves left `pending` when the API stopped between committing a
 * publish and starting its move. Starting is idempotent (the workflow id is
 * the operation id), so a move that is merely queued stays `pending`; one
 * whose start throws (the workflow service briefly down) also stays `pending`
 * for the next listing. Only a deployment without a move workflow fails it
 * (`move_unavailable`).
 */
async function redriveStalePendingMoves(
  deps: ApiRouteDeps,
  organizationId: string,
  operations: OrgAgentPublishOperation[],
): Promise<OrgAgentPublishOperation[]> {
  const now = Date.now();
  return await Promise.all(
    operations.map(async (operation) => {
      if (operation.status !== "pending") return operation;
      const createdAt = Date.parse(operation.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < STALE_PENDING_MOVE_MS) {
        return operation;
      }
      return (
        (await startMove(deps, organizationId, operation, { keepPendingOnError: true })) ??
        operation
      );
    }),
  );
}

/** Whether the caller may change publishes: Editor or Full, or a key with `agents:manage`. */
function canManageAgents(caller: Caller): boolean {
  return caller.apiKey
    ? hasPermission(caller.apiKey.permissions, "agents:manage")
    : caller.access === "editor" || caller.access === "full";
}

function workspaceLimit(deps: ApiRouteDeps): number | null {
  if (deps.settings.usageLimitsMode !== "static" && deps.settings.usageLimitsMode !== "managed") {
    return null;
  }
  return configuredStaticUsageLimits(deps.settings).maxWorkspacesPerAccount ?? null;
}

/**
 * The service principal one tester's Console test chats run as and are
 * started by (`sessions.created_by_*`): one per person (or organization key), never a person and never a
 * member of any workspace. Its chats are read and continued only through the
 * test-chats routes, by that tester while they may test agents.
 */
export function consoleTestChatSubjectId(testerSubjectId: string): string {
  return `${CONSOLE_TEST_CHAT_SUBJECT_PREFIX}${testerSubjectId}`;
}

/** What a test chat principal holds in the Console test workspace: its own chats, nothing else. */
export const CONSOLE_TEST_CHAT_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
]);

/**
 * The grant a tester's test chat runs with, built from the caller's Console
 * authorization on every request and never stored: their test chat
 * principal in the Console test workspace, explicit permissions (no
 * `workspace:admin`, so never `agents:manage`), with the tester recorded as
 * context only. No one gets a workspace membership. The chat's agent holds at
 * most these permissions too (an explicit grant narrows the agent's), and
 * test chats are created with `agentAccess: "session"`, so one tester's agent
 * never reaches another tester's chats.
 */
function consoleTestChatGrant(caller: Caller, workspaceId: string): AccessGrant {
  const subjectId = consoleTestChatSubjectId(caller.context.subjectId);
  const label = (caller.actor.label?.trim() || "Console test chat").slice(0, 250);
  return {
    accountId: caller.organizationId,
    workspaceId,
    subjectId,
    subjectLabel: label,
    permissions: [...CONSOLE_TEST_CHAT_PERMISSIONS],
    permissionMode: "explicit",
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId, label },
    serviceInitiatorContext: { consoleTesterSubjectId: caller.context.subjectId.slice(0, 1024) },
  };
}

/** The test workspace's model catalog, as the workspace's own routes resolve it. */
async function withWorkspaceCatalogSettings(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "accountId" | "workspaceId">,
): Promise<ApiRouteDeps> {
  const catalogSourceSettings = deps.catalogSourceSettings ?? deps.settings;
  return {
    ...deps,
    catalogSourceSettings,
    settings: (
      await resolveWorkspaceCatalogSettings(deps.db, catalogSourceSettings, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
      })
    ).settings,
  };
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
    // Nobody becomes a member here, the caller included: test chats run as
    // the tester's own service principal (consoleTestChatGrant) and are
    // read and continued only through the test-chats routes.
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
    requireAllWorkspacesKey(caller, "A tool server");
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
    requireAllWorkspacesKey(caller, "A tool server");
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
    requireAllWorkspacesKey(caller, "A tool server");
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
    // Summaries: no `workspaceIds` to scope.
    return c.json(ListOrgAgentsResponse.parse({ agents }));
  });

  // Runs on: the organization machines and sandbox environments an agent can
  // name, and whether each works in the workspaces the product manages.
  app.get(`${base}/compute`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const compute = await listOrgAgentCompute(deps.db, caller.organizationId);
    const option = (entry: (typeof compute.machines)[number]) => ({
      id: entry.id,
      sandboxId: entry.sandboxId,
      name: entry.name,
      worksInManagedWorkspaces: computeReachIncludesManagedWorkspaces(entry.reach),
    });
    return c.json(
      ListOrgAgentComputeResponse.parse({
        machines: compute.machines.map(option),
        environments: compute.environments.map(option),
      }),
    );
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
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }), 201);
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
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }));
  });

  app.put(`${base}/by-key/:key/apply`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:manage"], "full");
    const key = agentKey(c);
    const request = ApplyOrgAgentRequest.parse(await parseRequestJson(c, ApplyOrgAgentRequest));
    const { publish, moveRunningChats, dryRun, expectedVersion, ...rest } = request;
    if (publish && moveRunningChats && !dryRun) {
      requireAllWorkspacesKey(caller, "Moving running chats");
    }
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
    const operation = await startMove(deps, caller.organizationId, result.operation);
    return c.json(
      ApplyOrgAgentResponse.parse({
        ...result,
        agent: agentForCaller(caller, result.agent),
        operation,
      }),
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
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }));
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
        // A key limited to some workspaces changes only those; access in the
        // other workspaces stays as it is.
        ...(workspaceLimited(caller)
          ? { keepWorkspace: (workspaceId: string) => !inScope(caller, workspaceId) }
          : {}),
      }),
    );
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }));
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
    return c.json(
      SaveOrgAgentDraftResponse.parse({
        ...result,
        agent: agentForCaller(caller, result.agent),
      }),
      result.created ? 201 : 200,
    );
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
    if (request.moveRunningChats) requireAllWorkspacesKey(caller, "Moving running chats");
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
    const operation = await startMove(deps, caller.organizationId, result.operation);
    return c.json(
      PublishOrgAgentResponse.parse({
        ...result,
        agent: agentForCaller(caller, result.agent),
        operation,
      }),
    );
  });

  app.get(`${base}/:agentId/publish-operations`, async (c) => {
    const caller = await orgCaller(c, deps, ["agents:read"], "viewer");
    const listed = await listOrgAgentPublishOperations(
      deps.db,
      caller.organizationId,
      uuidParam(c, "agentId"),
    );
    if (!listed) throw agentNotFound();
    // Viewers and read-only keys only read; a caller who may publish also
    // re-drives a move the API left pending.
    const operations = canManageAgents(caller)
      ? await redriveStalePendingMoves(deps, caller.organizationId, listed)
      : listed;
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
    // For publishing (it counts chats people can't read in Console).
    const caller = await orgCaller(c, deps, ["agents:read", "agents:manage"], "editor");
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
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }));
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
    return c.json(OrgAgentResponse.parse({ agent: agentForCaller(caller, agent) }));
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
    // At the full level the list carries content (titles, what each chat
    // changed): audited before it is returned, as a transcript read is.
    if (reviewLevel === "full" && page.sessions.length > 0) {
      await recordConsoleAuditEvent(deps.db, {
        accountId: caller.organizationId,
        actorSubjectId: caller.actor.subjectId,
        actorLabel: caller.actor.label,
        action: "agent.sessions_viewed",
        workspaceId: null,
        sessionId: null,
        detail: {
          agentId,
          sessionIds: page.sessions.map((session) => session.id),
          ...(query.version !== undefined ? { version: query.version } : {}),
        },
      });
    }
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
    const caller = await measureSessionCreatePhase(deps.observability, "authorization", () =>
      orgCaller(c, deps, ["agents:manage"], "editor"),
    );
    const agentId = uuidParam(c, "agentId");
    const request = CreateOrgAgentTestChatRequest.parse(
      await measureSessionCreatePhase(deps.observability, "body_read", () =>
        parseRequestJson(c, CreateOrgAgentTestChatRequest),
      ),
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
    // The ordinary session create, as the tester's own test chat principal,
    // so every create rule (credits, models, limits, organization agent
    // resolution) applies. Logins pasted here are this chat's own.
    const logins = Object.entries(request.toolLogins ?? {});
    const grant = consoleTestChatGrant(caller, workspaceId);
    // Create keys are per workspace and every tester shares this one: the
    // stored key is derived from the tester's principal and the agent, so a
    // replay only ever returns this tester's own chat of this agent.
    const idempotencyKey = request.idempotencyKey
      ? `console-test:${await sha256Hex(`${grant.subjectId}\u0000${agentId}\u0000${request.idempotencyKey}`)}`
      : undefined;
    let created: { id: string };
    let replayed = false;
    try {
      const catalogDeps = await withWorkspaceCatalogSettings(deps, grant);
      const result = await measureSessionCreatePhase(deps.observability, "core_create", () =>
        createSessionForRequestWithOutcome(catalogDeps, grant, workspaceId, {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          initialMessage: request.message,
          // Every tester's chats share the test workspace: the agent reaches
          // only its own chat tree and keeps no Memory another tester's chat
          // could read.
          agentAccess: "session",
          memoryScope: "off",
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
        }),
      );
      created = result.session;
      // A start this key already made (finished again if it was cut short).
      replayed = result.outcome !== "created";
    } catch (error) {
      return sessionCreateErrorResponse(c, error);
    }
    return c.json(
      CreateOrgAgentTestChatResponse.parse({ workspaceId, sessionId: created.id }),
      replayed ? 200 : 201,
    );
  });

  /**
   * One of the caller's own test chats of this agent, or 404: a test chat is
   * its tester's alone (started by their test chat principal), whatever the
   * caller's Console access. Console review of the test workspace stays the
   * audited Console session routes.
   */
  async function ownTestChat(c: Context) {
    const caller = await orgCaller(c, deps, ["agents:manage"], "editor");
    const agentId = uuidParam(c, "agentId");
    const sessionId = uuidParam(c, "sessionId");
    const notFound = () => httpError(404, "test_chat_not_found", "Test chat not found.");
    const workspaceId = await findOrgAgentTestWorkspace(deps.db, caller.organizationId);
    if (!workspaceId || !inScope(caller, workspaceId)) throw notFound();
    const grant = consoleTestChatGrant(caller, workspaceId);
    // Started by this tester's own test chat principal (a service principal
    // records who started a chat, it cannot own one as a member).
    const creator = await getSessionCreator(deps.db, workspaceId, sessionId);
    if (creator?.kind !== "service" || creator.subjectId !== grant.subjectId) throw notFound();
    const session = await getSession(deps.db, workspaceId, sessionId);
    if (!session || session.orgAgent?.id !== agentId) throw notFound();
    return { caller, grant, workspaceId, session };
  }

  app.get(`${base}/:agentId/test-chats/:sessionId`, async (c) => {
    const { workspaceId, session } = await ownTestChat(c);
    return c.json(
      OrgAgentTestChatResponse.parse({
        workspaceId,
        sessionId: session.id,
        agentId: session.orgAgent!.id,
        version: session.orgAgent?.version ?? null,
        status: session.status,
        paused: session.effectiveControl.state === "paused",
      }),
    );
  });

  app.get(`${base}/:agentId/test-chats/:sessionId/events`, async (c) => {
    const { workspaceId, session } = await ownTestChat(c);
    const query = parseRequestQuery(OrgAgentTestChatEventsQuery, c.req.query(), {
      status: 422,
      message: "invalid test chat event query",
    });
    const page = await withConsoleSessionRead(() =>
      listSessionEventPage(deps.db, workspaceId, session.id, {
        after: query.after ?? 0,
        limit: query.limit ?? 500,
        direction: "after",
        payloadMode: "full",
        toolOutputPreview: true,
        defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
      }),
    );
    return c.json({ events: page.events, hasMore: page.hasMore, nextAfter: page.nextAfter });
  });

  app.post(`${base}/:agentId/test-chats/:sessionId/messages`, async (c) => {
    const { grant, workspaceId, session } = await ownTestChat(c);
    const request = await parseRequestJson(c, SendOrgAgentTestChatMessageRequest);
    let result: Awaited<ReturnType<typeof acceptSessionUserMessage>>;
    try {
      result = await acceptSessionUserMessage(
        await withWorkspaceCatalogSettings(deps, grant),
        grant,
        workspaceId,
        session.id,
        { text: request.message },
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
    recordAcceptedApiAdmission(deps.observability, result);
    return c.json(result.accepted, 202);
  });

  // Approve or decline an "Ask first" tool call waiting in the caller's own
  // test chat: the app's approval decision, recorded as the tester's.
  app.post(`${base}/:agentId/test-chats/:sessionId/approvals/:approvalId`, async (c) => {
    const { caller, grant, workspaceId, session } = await ownTestChat(c);
    const approvalId = c.req.param("approvalId") ?? "";
    if (approvalId.length === 0 || approvalId.length > 256) {
      throw httpError(404, "approval_not_found", "Approval not found.");
    }
    const request = await parseRequestJson(c, DecideOrgAgentTestChatApprovalRequest);
    let accepted: Awaited<ReturnType<typeof acceptSessionApprovalDecision>>;
    try {
      accepted = await acceptSessionApprovalDecision(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        respondedByKind: caller.apiKey ? "api" : "human",
        // Never confirms an app-action change: that needs the app's own sign-in.
        decidedBySignedInPerson: false,
        payload: {
          approvalId,
          decision: request.decision,
          ...(request.message !== undefined ? { message: request.message } : {}),
          ...(request.content !== undefined ? { content: request.content } : {}),
          ...(request.elicitationRound !== undefined
            ? { elicitationRound: request.elicitationRound }
            : {}),
        },
        clientEventId: request.clientEventId ?? null,
      });
    } catch (error) {
      if (error instanceof SessionApprovalAnswerError) {
        throw httpError(422, "validation_failed", error.message);
      }
      const forbidden = approvalForbiddenHttpError(error);
      if (forbidden) throw forbidden;
      throw error;
    }
    if (accepted.action === "conflict") {
      throw httpError(409, "conflict", accepted.message);
    }
    await publishDurableSessionEvents(deps.bus, workspaceId, session.id, accepted.events);
    await deps.workflowClient.signalApprovalDecision({
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      eventId: accepted.event.id,
      workflowId: workflowIdForSession(session.id),
      workflowWakeRevision: accepted.workflowWakeRevision,
    });
    return c.json(accepted.event, 202);
  });

  // Stop the caller's own test chat (pause interrupts what runs) or resume it.
  app.post(`${base}/:agentId/test-chats/:sessionId/control`, async (c) => {
    const { grant, workspaceId, session } = await ownTestChat(c);
    const request = await parseRequestJson(c, ControlOrgAgentTestChatRequest);
    try {
      const response = await controlHumanSessionWorkstream(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
        },
        { action: request.action, clientEventId: request.clientEventId ?? crypto.randomUUID() },
      );
      return c.json(
        ControlOrgAgentTestChatResponse.parse({
          paused: response.effectiveControl.state === "paused",
        }),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
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
