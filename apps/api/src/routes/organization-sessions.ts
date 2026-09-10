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

/**
 * Base64url JSON `{ workspaceId, cursor, pinnedOffset? }`; `cursor` is the
 * workspace list cursor or null. A subject's pinned sessions precede the
 * ordinary keyset page of a workspace; when a page boundary falls inside that
 * pinned prefix, `pinnedOffset` records how many pinned rows were already
 * returned so the next page resumes after them instead of repeating them.
 */
export type OrganizationSessionListCursor = {
  workspaceId: string;
  cursor: string | null;
  pinnedOffset?: number | undefined;
};

const OrganizationId = z.string().uuid();

const OrganizationSessionListCursorEnvelope = z
  .object({
    workspaceId: z.string().uuid(),
    cursor: z.string().min(1).nullable(),
    pinnedOffset: z.number().int().nonnegative().max(10_000).optional(),
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
    let pinnedOffset = 0;
    if (cursor) {
      index = workspaces.findIndex((workspace) => workspace.id >= cursor.workspaceId);
      if (index === -1) index = workspaces.length;
      if (workspaces[index]?.id === cursor.workspaceId) {
        innerCursor = cursor.cursor;
        pinnedOffset = cursor.cursor === null ? (cursor.pinnedOffset ?? 0) : 0;
      }
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
        pinnedOffset,
        limit: query.limit - sessions.length,
        query,
      });
      if (page === null) {
        // The caller holds no session read grant on this shared workspace
        // (an organization owner who is not a member). Skip it entirely.
        index += 1;
        innerCursor = null;
        pinnedOffset = 0;
        continue;
      }
      sessions.push(...page.sessions);
      if (page.nextPinnedOffset !== null) {
        // The page ended inside this workspace's pinned prefix.
        innerCursor = null;
        pinnedOffset = page.nextPinnedOffset;
        break;
      }
      pinnedOffset = 0;
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
            ...(innerCursor === null && pinnedOffset > 0 ? { pinnedOffset } : {}),
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
    /** Pinned rows already returned from this workspace's first page. */
    pinnedOffset: number;
    limit: number;
    query: ListOrganizationSessionsQuery;
  },
): Promise<{
  sessions: Session[];
  nextCursor: string | null;
  /** Set when the page boundary fell inside the pinned prefix; resume there with a null cursor. */
  nextPinnedOffset: number | null;
} | null> {
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
    const list = async (limit: number) =>
      await listSessionsForSubject(deps.db, input.workspace.id, {
        subjectId: grant.subjectId,
        limit,
        materializeSnapshot: true,
        ...(cursor ? { cursor } : {}),
        ...(input.query.scopeSubjectId !== undefined
          ? { scopeSubjectId: input.query.scopeSubjectId }
          : {}),
        ...(authorizationScope ? { authorizationScope } : {}),
        personalWorkspaceOwnerException: authorization.canonicalManagedHumanSession,
      });
    const withStatus = (rows: Session[]) =>
      input.query.status ? rows.filter((session) => session.status === input.query.status) : rows;
    let page = await list(input.limit);
    let rows: Session[];
    let nextPinnedOffset: number | null = null;
    if (cursor) {
      // A keyset continuation never carries pinned rows.
      rows = page.sessions;
    } else {
      // The subject's pinned sessions are excluded from the ordinary keyset
      // page and lead this workspace's first page. They count toward the
      // requested limit like any other row: when the boundary falls inside
      // the pinned prefix the caller resumes at `nextPinnedOffset`, and
      // otherwise the ordinary page is re-read at exactly the remaining
      // budget so its keyset cursor lands after the last returned row.
      const pinned = page.pinned.slice(input.pinnedOffset);
      if (pinned.length >= input.limit) {
        rows = pinned.slice(0, input.limit);
        nextPinnedOffset = input.pinnedOffset + input.limit;
        return { sessions: withStatus(rows), nextCursor: null, nextPinnedOffset };
      }
      if (pinned.length > 0 && page.sessions.length > input.limit - pinned.length) {
        page = await list(input.limit - pinned.length);
      }
      rows = [...pinned, ...page.sessions];
    }
    return { sessions: withStatus(rows), nextCursor: page.nextCursor, nextPinnedOffset };
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
