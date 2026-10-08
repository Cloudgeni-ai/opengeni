// The person's inbox: what waits on them across their workspaces. Session
// events open and close items (migration 0655); these routes read them and
// record the person's own attention. Answering a question or deciding an
// approval happens through the session's ordinary events, which close the item.
import {
  InboxSettings,
  ListInboxResponse,
  UpdateInboxItemRequest,
  type AccessContext,
  type InboxItem,
} from "@opengeni/contracts";
import { requireAccessContext, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getInboxItem,
  getInboxSettings,
  getSessionTitles,
  listInboxItems,
  listWorkspacesForSubject,
  setInboxSettings,
  updateInboxItemAttention,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/** Only a person has an inbox; keys and agents act through sessions. */
function requirePerson(context: AccessContext): string {
  if (!context.subjectId.startsWith("user:") || context.credential) {
    throw new HTTPException(403, { message: "Only a signed-in person has an inbox" });
  }
  return context.subjectId;
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
): Promise<Set<string>> {
  const readable = new Set<string>();
  await Promise.all(
    [...new Set(workspaceIds)].map(async (workspaceId) => {
      try {
        await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        readable.add(workspaceId);
      } catch {
        // No longer reachable: its items stay hidden until access returns.
      }
    }),
  );
  return readable;
}

function isNeedsYou(kind: InboxItem["kind"]): boolean {
  return kind !== "notification";
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
    const titles = new Map<string, string | null>();
    await Promise.all(
      [...readable].map(async (workspaceId) => {
        const ids = visible.filter((row) => row.workspaceId === workspaceId);
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
      .map((row) => ({ ...row, sessionTitle: titles.get(row.sessionId) ?? null }))
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
      return c.json(InboxSettings.parse({ tidyPolicy: "own_sessions", pausedGoals: false }));
    }
    return c.json(InboxSettings.parse(await getInboxSettings(deps.db, { accountId, subjectId })));
  });

  app.put("/v1/inbox/settings", async (c) => {
    const context = await requireAccessContext(c, deps);
    const subjectId = requirePerson(context);
    const parsed = InboxSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "Invalid inbox settings" });
    // The setting is the person's own; apply it in every organization they belong to.
    let settings: InboxSettings = { tidyPolicy: "own_sessions", pausedGoals: false };
    for (const accountId of await personAccounts(deps, context)) {
      settings = await setInboxSettings(deps.db, {
        accountId,
        subjectId,
        tidyPolicy: parsed.data.tidyPolicy,
        pausedGoals: parsed.data.pausedGoals,
      });
    }
    return c.json(InboxSettings.parse(settings));
  });
}
