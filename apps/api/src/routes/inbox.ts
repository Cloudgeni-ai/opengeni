// The person's inbox: what waits on them across their workspaces. Session
// events open and close items (migration 0655); these routes read them and
// record the person's own attention. Answering a question or deciding an
// approval happens through the session's ordinary events, which close the item.
import {
  InboxSettings,
  ListInboxResponse,
  MemberNotificationsSetting,
  SessionInboxMute,
  UpdateInboxItemRequest,
  type AccessGrant,
  type AccessContext,
  type InboxItem,
} from "@opengeni/contracts";
import {
  inboxSubjectForContext,
  requireAccessContext,
  requireAccessGrant,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  withResolvedSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getInboxItem,
  getInboxSettings,
  getMemberNotificationsAllowed,
  getSessionRepliesMuted,
  getSessionTitles,
  listInboxItems,
  listWorkspacesForSubject,
  setInboxSettings,
  setMemberNotificationsAllowed,
  setSessionRepliesMuted,
  updateInboxItemAttention,
  type InboxItemRow,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Only a person has an inbox: a signed-in person, or the one human of a local
 * install. Keys, services and agents act through sessions.
 */
function requirePerson(context: AccessContext): string {
  const subjectId = inboxSubjectForContext(context);
  if (!subjectId) {
    throw new HTTPException(403, { message: "Only a signed-in person has an inbox" });
  }
  return subjectId;
}

async function personAccounts(deps: ApiRouteDeps, context: AccessContext): Promise<string[]> {
  const accounts = new Set<string>([
    ...context.accountGrants.map((grant) => grant.accountId),
    ...context.workspaceGrants.map((grant) => grant.accountId),
  ]);
  if (accounts.size === 0) {
    for (const workspace of await listWorkspacesForSubject(deps.db, context.subjectId)) {
      accounts.add(workspace.accountId);
    }
  }
  return [...accounts];
}

/** Workspaces the person can still read sessions in; access can change after an item opened. */
async function readableWorkspaces(
  c: Context,
  deps: ApiRouteDeps,
  workspaceIds: Iterable<string>,
): Promise<Map<string, AccessGrant>> {
  const readable = new Map<string, AccessGrant>();
  await Promise.all(
    [...new Set(workspaceIds)].map(async (workspaceId) => {
      try {
        readable.set(workspaceId, await requireAccessGrant(c, deps, workspaceId, "sessions:read"));
      } catch {
        // No longer reachable: its items stay hidden until access returns.
      }
    }),
  );
  return readable;
}

/** Whether the person may open this session; any refusal or failure counts as no. */
async function sessionReadable(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
): Promise<boolean> {
  try {
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.read",
      surface: "http",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The items another member's agent sent from a session the person cannot
 * open (such as that member's private session). Those show no session: no
 * title and no link. The person's own items are never checked here.
 */
export async function itemsWithUnavailableSession(
  rows: readonly InboxItemRow[],
  canRead: (row: InboxItemRow) => Promise<boolean>,
): Promise<Set<string>> {
  const unavailable = new Set<string>();
  // One at a time: each check opens nested RLS reads (few items have a sender).
  for (const row of rows) {
    if (row.sender && !(await canRead(row))) unavailable.add(row.id);
  }
  return unavailable;
}

/** An inbox row as the person sees it. */
export function presentInboxItem(
  row: InboxItemRow,
  sessionTitle: string | null,
  sessionAvailable: boolean,
): InboxItem {
  return sessionAvailable
    ? { ...row, sessionTitle, sessionAvailable: true }
    : { ...row, sessionTitle: null, eventSequence: null, sessionAvailable: false };
}

function isNeedsYou(kind: InboxItem["kind"]): boolean {
  return kind === "question" || kind === "approval" || kind === "goal_paused";
}

// The mute routes name a target session outside the session module, so they
// call the session seam themselves; a session the caller cannot see is absent.
function muteSessionError(error: unknown): never {
  if (error instanceof SessionAuthorizationDeniedError)
    throw new HTTPException(404, { message: "Session not found" });
  if (error instanceof SessionAuthorizationUnavailableError)
    throw new HTTPException(503, { message: "Session authorization unavailable" });
  throw error;
}

export function registerInboxRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/inbox", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const workspaceFilter = c.req.query("workspaceId") ?? null;
    const rows = (
      await Promise.all(
        (
          await personAccounts(deps, context)
        ).map((accountId) => listInboxItems(deps.db, { accountId, subjectId })),
      )
    )
      .flat()
      .filter((row) => workspaceFilter === null || row.workspaceId === workspaceFilter);
    const readable = await readableWorkspaces(
      c,
      deps,
      rows.map((row) => row.workspaceId),
    );
    const visible = rows.filter((row) => readable.has(row.workspaceId));
    const unavailable = await itemsWithUnavailableSession(visible, (row) =>
      sessionReadable(deps, readable.get(row.workspaceId)!, row.sessionId),
    );
    const titles = new Map<string, string | null>();
    await Promise.all(
      [...readable.keys()].map(async (workspaceId) => {
        const ids = visible.filter(
          (row) => row.workspaceId === workspaceId && !unavailable.has(row.id),
        );
        const found = await getSessionTitles(
          deps.db,
          workspaceId,
          ids.map((row) => row.sessionId),
        );
        for (const [id, title] of found) titles.set(id, title);
      }),
    );
    const now = Date.now();
    const items: InboxItem[] = visible
      .map((row) =>
        presentInboxItem(row, titles.get(row.sessionId) ?? null, !unavailable.has(row.id)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const awake = items.filter(
      (item) => item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now,
    );
    c.header("cache-control", "private, no-store");
    return c.json(
      ListInboxResponse.parse({
        items,
        needsYouCount: awake.filter((item) => isNeedsYou(item.kind)).length,
        unreadCount: awake.filter((item) => item.unread).length,
      }),
    );
  });

  app.patch("/v1/inbox/items/:itemId", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const parsed = UpdateInboxItemRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "Invalid inbox update",
      });
    }
    const itemId = c.req.param("itemId");
    for (const accountId of await personAccounts(deps, context)) {
      const item = await getInboxItem(deps.db, { itemId, accountId, subjectId });
      if (!item) continue;
      await requireAccessGrant(c, deps, item.workspaceId, "sessions:read");
      await updateInboxItemAttention(deps.db, {
        itemId,
        accountId,
        subjectId,
        ...(parsed.data.seen ? { seen: true } : {}),
        ...(parsed.data.snoozedUntil !== undefined
          ? { snoozedUntil: parsed.data.snoozedUntil }
          : {}),
        ...(parsed.data.dismissed ? { dismissed: true } : {}),
      });
      return c.json({ ok: true });
    }
    throw new HTTPException(404, { message: "Inbox item not found" });
  });

  app.get("/v1/inbox/settings", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const accountId = context.defaultAccountId ?? (await personAccounts(deps, context))[0];
    if (!accountId) {
      return c.json(
        InboxSettings.parse({ tidyPolicy: "own_sessions", pausedGoals: false, replies: false }),
      );
    }
    return c.json(InboxSettings.parse(await getInboxSettings(deps.db, { accountId, subjectId })));
  });

  app.put("/v1/inbox/settings", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const parsed = InboxSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "Invalid inbox settings" });
    // The setting is the person's own; apply it in every organization they belong to.
    let settings: InboxSettings = {
      tidyPolicy: "own_sessions",
      pausedGoals: false,
      replies: false,
    };
    for (const accountId of await personAccounts(deps, context)) {
      settings = await setInboxSettings(deps.db, {
        accountId,
        subjectId,
        tidyPolicy: parsed.data.tidyPolicy,
        pausedGoals: parsed.data.pausedGoals,
        replies: parsed.data.replies,
      });
    }
    return c.json(InboxSettings.parse(settings));
  });

  // Whether other members' agents may notify this person in one workspace.
  // Each person decides for themselves; off by default.
  app.get("/v1/workspaces/:workspaceId/inbox/member-notifications", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    c.header("cache-control", "private, no-store");
    return c.json(
      MemberNotificationsSetting.parse({
        allowOthers: await getMemberNotificationsAllowed(deps.db, { workspaceId, subjectId }),
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/inbox/member-notifications", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const parsed = MemberNotificationsSetting.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "Invalid member notification setting" });
    }
    return c.json(
      MemberNotificationsSetting.parse({
        allowOthers: await setMemberNotificationsAllowed(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId,
          allowed: parsed.data.allowOthers,
        }),
      }),
    );
  });

  // The person's own mute on one session: its replies stop reaching their
  // inbox and phone; its notifications, questions and approvals still arrive.
  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/inbox-mute", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const authorization = await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.read",
      surface: "http",
    }).catch(muteSessionError);
    const read = () => getSessionRepliesMuted(deps.db, { workspaceId, sessionId, subjectId });
    const muted = authorization
      ? await withResolvedSessionAuthorization(authorization, read)
      : await read();
    if (muted === null) throw new HTTPException(404, { message: "Session not found" });
    c.header("cache-control", "private, no-store");
    return c.json(SessionInboxMute.parse({ repliesMuted: muted }));
  });

  app.put("/v1/workspaces/:workspaceId/sessions/:sessionId/inbox-mute", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const parsed = SessionInboxMute.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "Invalid session mute" });
    const repliesMuted = parsed.data.repliesMuted;
    const authorization = await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.attention.write",
      surface: "http",
    }).catch(muteSessionError);
    const write = () =>
      setSessionRepliesMuted(deps.db, { workspaceId, sessionId, subjectId, muted: repliesMuted });
    const muted = authorization
      ? await withResolvedSessionAuthorization(authorization, write)
      : await write();
    if (muted === null) throw new HTTPException(404, { message: "Session not found" });
    return c.json(SessionInboxMute.parse({ repliesMuted: muted }));
  });
}
