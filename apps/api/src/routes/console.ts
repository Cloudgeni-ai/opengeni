/**
 * Opengeni Console API: `/v1/organizations/:organizationId/console/*`.
 *
 * For organization owners and admins only (never an API key or a product's
 * end user). They review the sessions of the workspaces the product manages
 * (created by an organization API key, or marked in Console), see metered
 * cost, and read the audit log. Team workspaces show cost and counts only.
 *
 * What a reader may see is enforced here and in `@opengeni/db/console`:
 * managed workspaces only; shared sessions and end users' private sessions
 * only (an Opengeni account's private chat never); no content at the
 * `metadata` review level and nothing at `off`. Every transcript or metadata
 * open is written to the audit log before it is returned. All reads are
 * read-only.
 */
import {
  ConsoleApiKeyUsageResponse,
  ConsoleAuditEventListResponse,
  ConsoleRangeQuery,
  ConsoleSessionDetail,
  ConsoleSessionEventsQuery,
  ConsoleSessionListResponse,
  ConsoleSettings,
  ConsoleSummary,
  ConsoleWorkspaceListResponse,
  ListConsoleAuditEventsQuery,
  ListConsoleSessionsQuery,
  ListConsoleWorkspacesQuery,
  UpdateConsoleSettingsRequest,
  UpdateConsoleWorkspaceRequest,
  SESSION_EVENT_RAW_DELTA_TYPES,
  type AccessContext,
  type ConsoleRange,
  type ConsoleReviewLevel,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  holdsOrganizationAdministration,
  requireAccessContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  ConsoleCursorError,
  consoleSessionCounts,
  consoleApiKeyCreators,
  consoleSpendBreakdown,
  consoleSpendByApiKey,
  consoleSpendByWorkspace,
  decodeConsoleSessionCursor,
  getConsoleReviewSettings,
  getConsoleSession,
  listConsoleAuditEvents,
  listConsoleOrganizationWorkspaces,
  listConsoleSessions,
  listManagedWorkspaceMarkers,
  listSessionEventPage,
  recordConsoleAuditEvent,
  recordConsoleAuditEventOnce,
  setConsoleReviewLevel,
  setConsoleWorkspaceKind,
  withConsoleSessionRead,
  type ConsoleOrganizationWorkspace,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestJson, parseRequestQuery } from "../http/request-body";

const Id = z.string().uuid();

const RANGE_DAYS: Record<ConsoleRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function consoleWindow(range: ConsoleRange, now = new Date()) {
  const until = now.toISOString();
  const since = new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString();
  return { since, until };
}

function param(c: Context, name: string): string {
  const parsed = Id.safeParse(c.req.param(name));
  if (!parsed.success) throw new HTTPException(422, { message: `invalid ${name}` });
  return parsed.data;
}

export type ConsoleAdministrator = {
  context: AccessContext;
  subjectId: string;
  label: string | null;
};

/**
 * Console is for the organization's owners and admins themselves. An API key
 * (organization, workspace or developer setup) and a product's end user are
 * refused even when they hold administrative permissions: keys build the
 * product, people review it.
 */
export function requireConsoleAdministratorContext(
  context: AccessContext,
  organizationId: string,
): ConsoleAdministrator {
  if (
    context.subjectId.startsWith("api_key:") ||
    context.subjectId.startsWith("external_user:") ||
    accountScopedApiKeyWorkspaceAuthority(context) !== null
  ) {
    throw new HTTPException(403, {
      message: "Opengeni Console is for organization owners and admins",
    });
  }
  if (!holdsOrganizationAdministration(context, organizationId)) {
    throw new HTTPException(403, {
      message: "Opengeni Console is for organization owners and admins",
    });
  }
  return { context, subjectId: context.subjectId, label: context.subjectLabel ?? null };
}

async function requireConsoleAdministrator(
  c: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<ConsoleAdministrator> {
  return requireConsoleAdministratorContext(await requireAccessContext(c, deps), organizationId);
}

/** The organization's managed workspaces, by id. */
async function managedWorkspaces(
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<{ all: ConsoleOrganizationWorkspace[]; managed: ConsoleOrganizationWorkspace[] }> {
  const [all, markers] = await Promise.all([
    listConsoleOrganizationWorkspaces(deps.db, organizationId),
    listManagedWorkspaceMarkers(deps.db, organizationId),
  ]);
  return { all, managed: all.filter((workspace) => markers.has(workspace.id)) };
}

function reviewOff(): HTTPException {
  return new HTTPException(403, {
    message: "Session review is off for this organization",
  });
}

function withLevelGate(level: ConsoleReviewLevel): { includeContent: boolean } {
  if (level === "off") throw reviewOff();
  return { includeContent: level === "full" };
}

export function registerConsoleRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/organizations/:organizationId/console";

  app.get(`${base}/summary`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const { range } = parseRequestQuery(ConsoleRangeQuery, c.req.query(), {
      status: 400,
      message: "invalid Console query",
    });
    const window = consoleWindow(range);
    const [{ all, managed }, settings, spendByWorkspace, breakdown] = await Promise.all([
      managedWorkspaces(deps, organizationId),
      getConsoleReviewSettings(deps.db, organizationId),
      consoleSpendByWorkspace(deps.db, organizationId, window),
      consoleSpendBreakdown(deps.db, organizationId, window),
    ]);
    const managedIds = new Set(managed.map((workspace) => workspace.id));
    const teamIds = new Set(all.filter((w) => !managedIds.has(w.id)).map((w) => w.id));
    let managedMicros = 0;
    let teamMicros = 0;
    let otherMicros = 0;
    for (const [workspaceId, micros] of spendByWorkspace) {
      if (workspaceId && managedIds.has(workspaceId)) managedMicros += micros;
      else if (workspaceId && teamIds.has(workspaceId)) teamMicros += micros;
      else otherMicros += micros;
    }
    const counts = await consoleSessionCounts(deps.db, organizationId, [...managedIds], window, {
      endUsersFor: managedIds,
    });
    const byDay = new Map<string, number>();
    for (const point of breakdown.byDay) {
      byDay.set(point.date, (byDay.get(point.date) ?? 0) + point.spendMicros);
    }
    return c.json(
      ConsoleSummary.parse({
        organizationId,
        range,
        ...window,
        reviewLevel: settings.reviewLevel,
        spend: {
          totalMicros: Math.max(0, managedMicros + teamMicros + otherMicros),
          managedMicros: Math.max(0, managedMicros),
          teamMicros: Math.max(0, teamMicros),
          otherMicros: Math.max(0, otherMicros),
          byDay: [...byDay].map(([date, spendMicros]) => ({
            date,
            spendMicros: Math.max(0, spendMicros),
          })),
          byModel: breakdown.byModel.map((entry) => ({
            model: entry.model,
            spendMicros: Math.max(0, entry.spendMicros),
            calls: Math.max(0, entry.calls),
            inputTokens: Math.max(0, entry.inputTokens),
            outputTokens: Math.max(0, entry.outputTokens),
            cachedTokens: Math.max(0, entry.cachedTokens),
          })),
        },
        workspaces: { managed: managedIds.size, team: teamIds.size },
        managedSessions: [...counts.sessions.values()].reduce((sum, value) => sum + value, 0),
        endUsers: counts.endUsers,
        countsTruncated: counts.truncated,
      }),
    );
  });

  app.get(`${base}/workspaces`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const query = parseRequestQuery(ListConsoleWorkspacesQuery, c.req.query(), {
      status: 400,
      message: "invalid Console workspace query",
    });
    const window = consoleWindow(query.range);
    const [all, markers, spend] = await Promise.all([
      listConsoleOrganizationWorkspaces(deps.db, organizationId),
      listManagedWorkspaceMarkers(deps.db, organizationId),
      consoleSpendByWorkspace(deps.db, organizationId, window),
    ]);
    const selected = all.filter((workspace) =>
      query.kind === "all" ? true : (query.kind === "managed") === markers.has(workspace.id),
    );
    const counts = await consoleSessionCounts(
      deps.db,
      organizationId,
      selected.map((workspace) => workspace.id),
      window,
    );
    return c.json(
      ConsoleWorkspaceListResponse.parse({
        range: query.range,
        ...window,
        workspaces: selected.map((workspace) => {
          const marker = markers.get(workspace.id);
          return {
            id: workspace.id,
            name: workspace.name,
            kind: marker ? "managed" : "team",
            managedSource: marker?.source ?? null,
            createdByApiKeyId: marker?.createdByApiKeyId ?? null,
            externalSource: workspace.externalSource,
            externalId: workspace.externalId,
            createdAt: workspace.createdAt,
            spendMicros: Math.max(0, spend.get(workspace.id) ?? 0),
            sessions: counts.sessions.get(workspace.id) ?? 0,
            lastActivityAt: counts.lastActivity.get(workspace.id) ?? null,
          };
        }),
      }),
    );
  });

  app.put(`${base}/workspaces/:workspaceId`, async (c) => {
    const organizationId = param(c, "organizationId");
    const workspaceId = param(c, "workspaceId");
    const admin = await requireConsoleAdministrator(c, deps, organizationId);
    const body = await parseRequestJson(c, UpdateConsoleWorkspaceRequest);
    const all = await listConsoleOrganizationWorkspaces(deps.db, organizationId);
    if (!all.some((workspace) => workspace.id === workspaceId)) {
      throw new HTTPException(404, { message: "workspace not found" });
    }
    await setConsoleWorkspaceKind(deps.db, {
      accountId: organizationId,
      workspaceId,
      kind: body.kind,
      actorSubjectId: admin.subjectId,
      actorLabel: admin.label,
    });
    return c.json({ workspaceId, kind: body.kind });
  });

  app.get(`${base}/sessions`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const query = parseRequestQuery(ListConsoleSessionsQuery, c.req.query(), {
      status: 400,
      message: "invalid Console session query",
    });
    const settings = await getConsoleReviewSettings(deps.db, organizationId);
    const { includeContent } = withLevelGate(settings.reviewLevel);
    let cursor = null;
    try {
      cursor = query.cursor ? decodeConsoleSessionCursor(query.cursor) : null;
    } catch (error) {
      if (error instanceof ConsoleCursorError)
        throw new HTTPException(400, { message: "cursor is invalid" });
      throw error;
    }
    const { managed } = await managedWorkspaces(deps, organizationId);
    const workspaces = query.workspaceId
      ? managed.filter((workspace) => workspace.id === query.workspaceId)
      : managed;
    const page = await listConsoleSessions(deps.db, {
      accountId: organizationId,
      workspaces,
      limit: query.limit,
      cursor,
      q: query.q ?? null,
      includeContent,
    });
    return c.json(ConsoleSessionListResponse.parse({ reviewLevel: settings.reviewLevel, ...page }));
  });

  async function reviewableSession(c: Context, organizationId: string, includeContent: boolean) {
    const workspaceId = param(c, "workspaceId");
    const sessionId = param(c, "sessionId");
    const { managed } = await managedWorkspaces(deps, organizationId);
    const workspace = managed.find((candidate) => candidate.id === workspaceId);
    // A team workspace, another organization's workspace and an Opengeni
    // account's private chat all read as absent.
    if (!workspace) throw new HTTPException(404, { message: "session not found" });
    const detail = await getConsoleSession(deps.db, {
      accountId: organizationId,
      workspace,
      sessionId,
      includeContent,
    });
    if (!detail) throw new HTTPException(404, { message: "session not found" });
    return { workspace, detail };
  }

  app.get(`${base}/workspaces/:workspaceId/sessions/:sessionId`, async (c) => {
    const organizationId = param(c, "organizationId");
    const admin = await requireConsoleAdministrator(c, deps, organizationId);
    const settings = await getConsoleReviewSettings(deps.db, organizationId);
    const { includeContent } = withLevelGate(settings.reviewLevel);
    const { workspace, detail } = await reviewableSession(c, organizationId, includeContent);
    // Written before anything is returned: no read without its audit entry.
    const auditEventId = await recordConsoleAuditEvent(deps.db, {
      accountId: organizationId,
      actorSubjectId: admin.subjectId,
      actorLabel: admin.label,
      action: includeContent ? "session.transcript_viewed" : "session.metadata_viewed",
      workspaceId: workspace.id,
      sessionId: detail.summary.id,
      detail: {
        workspaceName: workspace.name.slice(0, 200),
        ...(detail.summary.endUser ? { endUser: detail.summary.endUser.subjectId } : {}),
      },
    });
    return c.json(
      ConsoleSessionDetail.parse({
        reviewLevel: settings.reviewLevel,
        session: detail.summary,
        model: detail.model,
        reasoningEffort: detail.reasoningEffort,
        durationMs: detail.durationMs,
        tokens: detail.tokens,
        modelCalls: detail.modelCalls,
        models: detail.models,
        toolCalls: detail.toolCalls,
        feedback: detail.feedback,
        auditEventId,
      }),
    );
  });

  app.get(`${base}/workspaces/:workspaceId/sessions/:sessionId/events`, async (c) => {
    const organizationId = param(c, "organizationId");
    const admin = await requireConsoleAdministrator(c, deps, organizationId);
    const settings = await getConsoleReviewSettings(deps.db, organizationId);
    if (settings.reviewLevel !== "full") {
      throw new HTTPException(403, {
        message: "Transcripts are not available at this review level",
      });
    }
    const { workspace, detail } = await reviewableSession(c, organizationId, true);
    const query = parseRequestQuery(ConsoleSessionEventsQuery, c.req.query(), {
      status: 400,
      message: "invalid Console event query",
    });
    // Audited like the detail read, before any content is returned.
    await recordConsoleAuditEventOnce(deps.db, {
      accountId: organizationId,
      actorSubjectId: admin.subjectId,
      actorLabel: admin.label,
      action: "session.transcript_viewed",
      workspaceId: workspace.id,
      sessionId: detail.summary.id,
      detail: {
        workspaceName: workspace.name.slice(0, 200),
        ...(detail.summary.endUser ? { endUser: detail.summary.endUser.subjectId } : {}),
      },
    });
    const page = await withConsoleSessionRead(() =>
      listSessionEventPage(deps.db, workspace.id, detail.summary.id, {
        after: query.after,
        limit: query.limit,
        direction: "after",
        payloadMode: "full",
        toolOutputPreview: true,
        defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES,
      }),
    );
    return c.json({
      events: page.events,
      hasMore: page.hasMore,
      nextAfter: page.nextAfter,
    });
  });

  app.get(`${base}/settings`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const settings = await getConsoleReviewSettings(deps.db, organizationId);
    return c.json(ConsoleSettings.parse({ organizationId, ...settings }));
  });

  app.put(`${base}/settings`, async (c) => {
    const organizationId = param(c, "organizationId");
    const admin = await requireConsoleAdministrator(c, deps, organizationId);
    const body = await parseRequestJson(c, UpdateConsoleSettingsRequest);
    const settings = await setConsoleReviewLevel(deps.db, {
      accountId: organizationId,
      reviewLevel: body.reviewLevel,
      actorSubjectId: admin.subjectId,
      actorLabel: admin.label,
    });
    return c.json(ConsoleSettings.parse({ organizationId, ...settings }));
  });

  app.get(`${base}/audit-log`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const query = parseRequestQuery(ListConsoleAuditEventsQuery, c.req.query(), {
      status: 400,
      message: "invalid Console audit query",
    });
    let page;
    try {
      page = await listConsoleAuditEvents(deps.db, {
        accountId: organizationId,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      });
    } catch (error) {
      if (error instanceof ConsoleCursorError)
        throw new HTTPException(400, { message: "cursor is invalid" });
      throw error;
    }
    const names = new Map(
      (await listConsoleOrganizationWorkspaces(deps.db, organizationId)).map((w) => [w.id, w.name]),
    );
    return c.json(
      ConsoleAuditEventListResponse.parse({
        events: page.events.map((event) => ({
          ...event,
          workspaceName:
            (event.workspaceId ? names.get(event.workspaceId) : undefined) ??
            (typeof event.detail.workspaceName === "string" ? event.detail.workspaceName : null),
        })),
        nextCursor: page.nextCursor,
      }),
    );
  });

  app.get(`${base}/api-keys`, async (c) => {
    const organizationId = param(c, "organizationId");
    await requireConsoleAdministrator(c, deps, organizationId);
    const { range } = parseRequestQuery(ConsoleRangeQuery, c.req.query(), {
      status: 400,
      message: "invalid Console query",
    });
    const window = consoleWindow(range);
    const [usage, creators] = await Promise.all([
      consoleSpendByApiKey(deps.db, organizationId, window),
      consoleApiKeyCreators(deps.db, organizationId),
    ]);
    const usageByKey = new Map(usage.map((entry) => [entry.apiKeyId, entry]));
    const keyIds = new Set([...usageByKey.keys(), ...creators.keys()]);
    return c.json(
      ConsoleApiKeyUsageResponse.parse({
        range,
        ...window,
        apiKeys: [...keyIds].map((apiKeyId) => ({
          apiKeyId,
          createdBySubjectId: creators.get(apiKeyId) ?? null,
          managedWorkspaces: usageByKey.get(apiKeyId)?.workspaces ?? 0,
          spendMicros: Math.max(0, usageByKey.get(apiKeyId)?.spendMicros ?? 0),
        })),
      }),
    );
  });
}
