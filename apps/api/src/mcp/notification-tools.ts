// Reaching the person who owns a session. A notification is a session event:
// it stays in the timeline, reaches webhook subscribers, opens an item in the
// person's inbox and, when new, alerts their phones. Posting the same key again
// updates that item in place without a new alert. Agents can withdraw their own
// notifications and, as the person allows, tidy others' — but never answer a
// question or decide an approval on the person's behalf.
import {
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_FACT_LABEL_MAX_CHARS,
  NOTIFICATION_FACT_VALUE_MAX_CHARS,
  NOTIFICATION_FACTS_MAX,
  NOTIFICATION_LINK_LABEL_MAX_CHARS,
  NOTIFICATION_SUBTITLE_MAX_CHARS,
  NOTIFICATION_TITLE_MAX_CHARS,
  NotificationKey,
  SessionNotificationPostedPayload,
  SessionNotificationWithdrawnPayload,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  dismissInboxNotification,
  getInboxTidyPolicy,
  getSession,
  getSessionInboxRecipient,
  listInboxItems,
  type InboxItemRow,
} from "@opengeni/db";
import { appendAndPublishEvents, appendAndPublishTurnEventsFenced } from "@opengeni/events";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

type AttemptClaims = {
  callerTurnId: string;
  callerExecutionGeneration: number;
  callerAttemptId: string;
};

export type RegisterNotificationToolsInput = {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  /** The calling attempt; notifications are fenced to it. */
  attempt: () => AttemptClaims;
  json: JsonResult;
};

/** The person a session works for (its owner, else who started it), or null when no person does. */
async function sessionOwner(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
): Promise<{ subjectId: string; parentSessionId: string | null } | null> {
  return await getSessionInboxRecipient(deps.db, workspaceId, sessionId);
}

/** Whether `ancestorId` is `sessionId` or one of the sessions above it (bounded). */
async function isSelfOrAncestor(
  deps: ApiRouteDeps,
  workspaceId: string,
  ancestorId: string,
  sessionId: string,
): Promise<boolean> {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current === ancestorId) return true;
    current = (await getSession(deps.db, workspaceId, current))?.parentSessionId ?? null;
  }
  return false;
}

export function registerNotificationTools(input: RegisterNotificationToolsInput): void {
  const { server, deps, grant, sessionId, authorize, attempt, json } = input;

  const appendOwn = async (events: Array<{ type: string; payload: unknown }>) => {
    const claims = attempt();
    const appended = await appendAndPublishTurnEventsFenced(
      deps.db,
      deps.bus,
      grant.workspaceId,
      sessionId,
      claims.callerTurnId,
      claims.callerExecutionGeneration,
      claims.callerAttemptId,
      events as Parameters<typeof appendAndPublishTurnEventsFenced>[7],
    );
    if (!appended.accepted) {
      throw new Error("The calling turn was replaced before the notification committed.");
    }
  };

  server.registerTool(
    "notify_user",
    {
      description: [
        "Notify the person who owns this session: it goes to their inbox and, when new, to their phone. It always links back to this point in this session, so never add a link to the session yourself.",
        "Use it sparingly, for something they would want to know while away: a long task finished, a result is ready, or you are blocked on them. Questions and approvals already reach them; don't duplicate those.",
        "Write it like a good phone notification. title: what happened, a few words ('Release 2.4 is live'). subtitle (optional): what it's about ('Billing service'). message (optional): one or two short sentences or up to four '- ' bullets; **bold**, `code` and [links](https://…) render in the inbox and become plain text on the lock screen. facts (optional): up to four short label/value pairs for the numbers that matter ('Tests' / '412 passed'). link (optional): one https place outside the session worth opening, such as a pull request or dashboard. Keep secrets out.",
        "Give each notification a stable key: posting the same key again updates it in place without a new alert (for progress such as '7 of 10 done'). urgency time_sensitive breaks through Focus on their phone; use it only for what cannot wait. Withdraw it with notification_withdraw when it no longer applies.",
      ].join(" "),
      inputSchema: {
        title: z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX_CHARS),
        subtitle: z.string().trim().max(NOTIFICATION_SUBTITLE_MAX_CHARS).optional(),
        message: z.string().trim().max(NOTIFICATION_BODY_MAX_CHARS).default(""),
        facts: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(NOTIFICATION_FACT_LABEL_MAX_CHARS),
              value: z.string().trim().min(1).max(NOTIFICATION_FACT_VALUE_MAX_CHARS),
            }),
          )
          .max(NOTIFICATION_FACTS_MAX)
          .optional(),
        link: z
          .object({
            url: z.string().trim().max(2000).describe("An https URL outside this session."),
            label: z.string().trim().min(1).max(NOTIFICATION_LINK_LABEL_MAX_CHARS),
          })
          .optional(),
        key: z
          .string()
          .max(120)
          .optional()
          .describe("Stable id for this notification, e.g. 'migration' or 'report-ready'."),
        urgency: z.enum(["normal", "time_sensitive"]).default("normal"),
      },
    },
    async ({ title, subtitle, message, facts, link, key, urgency }) => {
      await authorize();
      const resolvedKey = NotificationKey.parse(key ?? `n-${crypto.randomUUID().slice(0, 8)}`);
      const owner = await sessionOwner(deps, grant.workspaceId, sessionId);
      const existing = owner
        ? (
            await listInboxItems(deps.db, {
              accountId: grant.accountId,
              subjectId: owner.subjectId,
            })
          ).find(
            (item) =>
              item.sessionId === sessionId &&
              item.kind === "notification" &&
              item.sourceKey === resolvedKey,
          )
        : undefined;
      const parsed = SessionNotificationPostedPayload.safeParse({
        key: resolvedKey,
        title,
        ...(subtitle ? { subtitle } : {}),
        body: message,
        ...(facts && facts.length > 0 ? { facts } : {}),
        ...(link ? { link } : {}),
        urgency,
        replaced: Boolean(existing),
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Invalid notification${issue ? ` (${issue.path.join(".") || "input"}): ${issue.message}` : ""}`,
        );
      }
      const payload = parsed.data;
      await appendOwn([{ type: "session.notification.posted", payload }]);
      return json({
        ok: true,
        key: resolvedKey,
        // No person owns this session (a key or service started it): nobody is notified.
        delivered: owner !== null,
        updatedInPlace: Boolean(existing),
      });
    },
  );

  server.registerTool(
    "notification_withdraw",
    {
      description:
        "Withdraw a notification this session posted (by its key) once it no longer applies, for example when you are no longer blocked. It leaves the person's inbox and their phone.",
      inputSchema: { key: z.string().min(1).max(120) },
    },
    async ({ key }) => {
      await authorize();
      const payload = SessionNotificationWithdrawnPayload.parse({
        key: NotificationKey.parse(key),
      });
      await appendOwn([{ type: "session.notification.withdrawn", payload }]);
      return json({ ok: true, key: payload.key });
    },
  );

  server.registerTool(
    "inbox_tidy",
    {
      description:
        "See and tidy the notifications in the inbox of the person who started this session. Lists the open agent notifications you may tidy: by default those from this session and sessions under it; every session's when the person allows any agent to tidy. Pass dismissItemIds to dismiss stale or duplicate ones. Questions, approvals and paused goals are never listed: only the person settles those.",
      inputSchema: {
        dismissItemIds: z.array(z.string().uuid()).max(50).default([]),
      },
    },
    async ({ dismissItemIds }) => {
      await authorize();
      const owner = await sessionOwner(deps, grant.workspaceId, sessionId);
      if (!owner) return json({ ok: true, notifications: [], dismissed: [] });
      const scope = { accountId: grant.accountId, subjectId: owner.subjectId };
      const policy = await getInboxTidyPolicy(deps.db, scope);
      const allowed = async (item: InboxItemRow): Promise<boolean> => {
        if (item.kind !== "notification") return false;
        if (policy === "any_agent") return true;
        return (
          item.workspaceId === grant.workspaceId &&
          (await isSelfOrAncestor(deps, grant.workspaceId, sessionId, item.sessionId))
        );
      };
      const items = await listInboxItems(deps.db, scope);
      const tidyable: InboxItemRow[] = [];
      for (const item of items) if (await allowed(item)) tidyable.push(item);
      const dismissed: string[] = [];
      for (const itemId of dismissItemIds) {
        const item = tidyable.find((candidate) => candidate.id === itemId);
        if (!item) continue;
        if (await dismissInboxNotification(deps.db, { itemId, ...scope })) {
          dismissed.push(itemId);
          // Record the tidy on the posting session, so its timeline and hosts see it.
          await appendAndPublishEvents(deps.db, deps.bus, item.workspaceId, item.sessionId, [
            {
              type: "session.notification.withdrawn",
              payload: SessionNotificationWithdrawnPayload.parse({
                key: item.sourceKey,
                ...(item.sessionId === sessionId ? {} : { bySessionId: sessionId }),
              }),
            },
          ] as Parameters<typeof appendAndPublishEvents>[4]);
        }
      }
      return json({
        ok: true,
        policy,
        dismissed,
        notifications: tidyable
          .filter((item) => !dismissed.includes(item.id))
          .map((item) => ({
            itemId: item.id,
            sessionId: item.sessionId,
            title: item.title,
            message: item.body,
            updatedAt: item.updatedAt,
          })),
      });
    },
  );
}
