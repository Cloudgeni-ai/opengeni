import {
  ListOrganizationSessionsQuery,
  type AccessContext,
  type OrganizationSessionListResponse,
  type Session,
  type Workspace,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  hasPermission,
  requireAccessContext,
  requireAccessGrantAuthorization,
  requireSessionAuthorizationListScope,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  decodeSessionListCursor,
  listSessionsForSubject,
  listSharedWorkspacesForAccount,
  SessionListAccessError,
  SessionListCursorError,
  SessionListCursorExpiredError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/**
 * Upper bound on the workspace page reads one request performs. The
 * organization list fans out over every shared workspace in stable id order,
 * one RLS-scoped transaction per workspace, so an organization with many empty
 * tenant workspaces would otherwise turn a single request into an unbounded
 * scan. When the budget runs out the page is returned short with `nextCursor`
 * pointing at the next unread position.
 */
export const ORGANIZATION_SESSION_LIST_MAX_WORKSPACE_READS = 25;

/** Base64url JSON `{ workspaceId, cursor }`; `cursor` is the workspace list cursor or null. */
export type OrganizationSessionListCursor = {
  workspaceId: string;
  cursor: string | null;
};

const OrganizationId = z.string().uuid();

const OrganizationSessionListCursorEnvelope = z
  .object({
    workspaceId: z.string().uuid(),
    cursor: z.string().min(1).nullable(),
  })
  .strict();

export function encodeOrganizationSessionListCursor(cursor: OrganizationSessionListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeOrganizationSessionListCursor(
  value: string,
): OrganizationSessionListCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const envelope = OrganizationSessionListCursorEnvelope.safeParse(parsed);
  if (!envelope.success) return null;
  if (envelope.data.cursor !== null && !decodeSessionListCursor(envelope.data.cursor)) {
    return null;
  }
  return envelope.data;
}

type OrganizationSessionReadAuthority = "organization_api_key" | "account_admin";

/**
 * Who may read the organization-wide session list.
 *
 * An organization API key qualifies through its exact stamped workspace
 * authority when that authority carries `sessions:read` (a `full` key holds the
 * `workspace:admin` wildcard, a `read` key holds the literal). A human
 * organization owner qualifies through an `account:admin` account grant, but
 * that grant alone opens no workspace: every workspace is still authorized
 * through the ordinary per-workspace grant resolution below, so an owner sees
 * exactly the shared workspaces they are a member of.
 */
function requireOrganizationSessionReadAuthority(
  context: AccessContext,
  organizationId: string,
): OrganizationSessionReadAuthority {
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (authority) {
    if (
      authority.accountId === organizationId &&
      hasPermission(authority.permissions, "sessions:read")
    ) {
      return "organization_api_key";
    }
    throw new HTTPException(403, { message: "organization session read authority required" });
  }
  const accountGrant = context.accountGrants.find(
    (candidate) => candidate.accountId === organizationId,
  );
  if (accountGrant?.permissions.includes("account:admin")) {
    return "account_admin";
  }
  throw new HTTPException(403, { message: "organization session read authority required" });
}

/** Same projection as the workspace session list: denial reads as absence. */
function sessionAuthorizationHttpError(error: unknown): HTTPException {
  if (error instanceof SessionAuthorizationDeniedError) {
    return new HTTPException(404, { message: "session not found" });
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    return new HTTPException(503, { message: "session authorization is unavailable" });
  }
  if (error instanceof HTTPException) return error;
  throw error;
}

function compareWorkspaceIds(left: Workspace, right: Workspace): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function registerOrganizationSessionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organizations/:organizationId/sessions", async (c) => {
    const organizationIdResult = OrganizationId.safeParse(c.req.param("organizationId"));
    if (!organizationIdResult.success) {
      throw new HTTPException(422, { message: "invalid organization id" });
    }
    const organizationId = organizationIdResult.data;
    const context = await requireAccessContext(c, deps);
    const readAuthority = requireOrganizationSessionReadAuthority(context, organizationId);

    const queryResult = ListOrganizationSessionsQuery.safeParse(c.req.query());
    if (!queryResult.success) {
      const issue = queryResult.error.issues[0];
      throw new HTTPException(400, {
        message: issue
          ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`
          : "invalid organization session list query",
      });
    }
    const query = queryResult.data;
    const cursor = query.cursor ? decodeOrganizationSessionListCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      throw new HTTPException(400, { message: "cursor is invalid" });
    }

    // Personal workspaces are excluded by the inventory itself; the stable id
    // order is what makes the `{ workspaceId, cursor }` continuation resumable
    // even when a workspace is created or deleted between pages.
    const workspaces = (await listSharedWorkspacesForAccount(deps.db, organizationId)).sort(
      compareWorkspaceIds,
    );
    let index = 0;
    let innerCursor: string | null = null;
    if (cursor) {
      index = workspaces.findIndex((workspace) => workspace.id >= cursor.workspaceId);
      if (index === -1) index = workspaces.length;
      if (workspaces[index]?.id === cursor.workspaceId) innerCursor = cursor.cursor;
    }

    const sessions: Session[] = [];
    let reads = 0;
    while (
      index < workspaces.length &&
      sessions.length < query.limit &&
      reads < ORGANIZATION_SESSION_LIST_MAX_WORKSPACE_READS
    ) {
      const workspace = workspaces[index]!;
      reads += 1;
      const page = await listWorkspaceSessionPage(c, deps, {
        workspace,
        readAuthority,
        innerCursor,
        limit: query.limit - sessions.length,
        query,
      });
      if (page === null) {
        // The caller holds no session read grant on this shared workspace
        // (an organization owner who is not a member). Skip it entirely.
        index += 1;
        innerCursor = null;
        continue;
      }
      sessions.push(...page.sessions);
      if (page.nextCursor) {
        innerCursor = page.nextCursor;
      } else {
        index += 1;
        innerCursor = null;
      }
    }

    const nextWorkspace = workspaces[index];
    const response: OrganizationSessionListResponse = {
      sessions,
      nextCursor: nextWorkspace
        ? encodeOrganizationSessionListCursor({
            workspaceId: nextWorkspace.id,
            cursor: innerCursor,
          })
        : null,
    };
    return c.json(response);
  });
}

/**
 * One RLS-scoped workspace page, authorized exactly like
 * `GET /v1/workspaces/:workspaceId/sessions`: the ordinary per-workspace grant
 * (synthesized for an organization key, membership-backed for a human), the
 * host list scope, and the subject-keyed row visibility. Private sessions the
 * subject does not own never leave the database. Returns null only when an
 * account administrator holds no session read grant on the workspace.
 */
async function listWorkspaceSessionPage(
  c: Context,
  deps: ApiRouteDeps,
  input: {
    workspace: Workspace;
    readAuthority: OrganizationSessionReadAuthority;
    innerCursor: string | null;
    limit: number;
    query: ListOrganizationSessionsQuery;
  },
): Promise<{ sessions: Session[]; nextCursor: string | null } | null> {
  let authorization: Awaited<ReturnType<typeof requireAccessGrantAuthorization>>;
  try {
    authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      input.workspace.id,
      "sessions:read",
    );
  } catch (error) {
    if (
      input.readAuthority === "account_admin" &&
      error instanceof HTTPException &&
      error.status === 403
    ) {
      return null;
    }
    throw error;
  }
  const grant = authorization.grant;
  let authorizationScope;
  try {
    authorizationScope = await requireSessionAuthorizationListScope(deps, grant, "http");
  } catch (error) {
    throw sessionAuthorizationHttpError(error);
  }
  const cursor = input.innerCursor ? decodeSessionListCursor(input.innerCursor) : null;
  if (input.innerCursor && !cursor) {
    throw new HTTPException(400, { message: "cursor is invalid" });
  }
  try {
    const page = await listSessionsForSubject(deps.db, input.workspace.id, {
      subjectId: grant.subjectId,
      limit: input.limit,
      materializeSnapshot: true,
      ...(cursor ? { cursor } : {}),
      ...(input.query.endUserSource !== undefined && input.query.endUserId !== undefined
        ? { endUser: { source: input.query.endUserSource, id: input.query.endUserId } }
        : {}),
      ...(authorizationScope ? { authorizationScope } : {}),
      personalWorkspaceOwnerException: authorization.canonicalManagedHumanSession,
    });
    // Pinned rows are excluded from the ordinary page and belong to the
    // subject's first page of this workspace only.
    const rows = cursor ? page.sessions : [...page.pinned, ...page.sessions];
    return {
      sessions: input.query.status
        ? rows.filter((session) => session.status === input.query.status)
        : rows,
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    if (error instanceof SessionListAccessError) {
      throw new HTTPException(403, { message: error.message });
    }
    if (error instanceof SessionListCursorExpiredError) {
      throw new HTTPException(410, { message: error.message });
    }
    if (error instanceof SessionListCursorError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
}
