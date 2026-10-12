// Reaching the person who owns a session. A notification is a session event:
// it stays in the timeline, reaches webhook subscribers, opens an item in the
// person's inbox and, when new, alerts their phones. Posting the same key again
// updates that item in place without a new alert. Agents can withdraw their own
// notifications and, as the person allows, tidy others' or look after the whole
// inbox (see, snooze and dismiss any item) — but never answer a question or
// decide an approval on the person's behalf.
//
// An agent can also notify another member of its workspace, when that member
// allows other people's agents to (per workspace, off by default). It shows
// them who it came from: the person the session works for.
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
  getManagedUserByEmail,
  getManagedUserProfilesByIds,
  getMemberNotificationsAllowed,
  getSession,
  getSessionInboxRecipient,
  getSessionTitles,
  listInboxItems,
  listWorkspaceMembers,
  updateInboxItemAttention,
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

/** Questions, approvals and paused goals wait on the person; replies and notes don't. */
function needsPerson(item: InboxItemRow): boolean {
  return item.kind === "question" || item.kind === "approval" || item.kind === "goal_paused";
}

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

type Member = { subjectId: string; label: string };

/**
 * The workspace member a `recipient` names: their subject id, their email or
 * their member name (case-insensitive). Null when it names nobody in the
 * workspace, or more than one person.
 */
async function resolveMember(
  deps: ApiRouteDeps,
  workspaceId: string,
  recipient: string,
): Promise<Member | null> {
  const members = await listWorkspaceMembers(deps.db, workspaceId);
  const wanted = recipient.trim();
  const lowered = wanted.toLowerCase();
  const toMember = (member: (typeof members)[number]): Member => ({
    subjectId: member.subjectId,
    label: member.subjectLabel?.trim() || member.subjectId,
  });
  const byId = members.find((member) => member.subjectId === wanted);
  if (byId) return toMember(byId);
  if (wanted.includes("@")) {
    const userId = await getManagedUserByEmail(deps.db, wanted).catch(() => null);
    const byEmail = userId
      ? members.find((member) => member.subjectId === `user:${userId}`)
      : members.find((member) => member.subjectLabel?.trim().toLowerCase() === lowered);
    if (byEmail) return toMember(byEmail);
  }
  const byName = members.filter((member) => member.subjectLabel?.trim().toLowerCase() === lowered);
  return byName.length === 1 ? toMember(byName[0]!) : null;
}

/** How a person is named to other members: their member name, else their profile. */
async function personLabel(
  deps: ApiRouteDeps,
  workspaceId: string,
  subjectId: string,
): Promise<string> {
  const member = (await listWorkspaceMembers(deps.db, workspaceId)).find(
    (each) => each.subjectId === subjectId,
  );
  const named = member?.subjectLabel?.trim();
  if (named) return named.slice(0, 200);
  if (subjectId.startsWith("user:")) {
    const [profile] = await getManagedUserProfilesByIds(deps.db, [subjectId.slice(5)]).catch(
      () => [],
    );
    const fromProfile = profile?.name?.trim() || profile?.email?.trim();
    if (fromProfile) return fromProfile.slice(0, 200);
  }
  return "A teammate";
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
        "recipient (optional): notify another member of this workspace instead, by their email or name. They see who it came from (the person this session works for). It only reaches people who allow other members' agents to notify them; otherwise you get an error saying so. Don't retry then: tell the person you work for.",
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
        recipient: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .optional()
          .describe(
            "Another workspace member to notify, by email or name. Omit to notify the person you work for.",
          ),
      },
    },
    async ({ title, subtitle, message, facts, link, key, urgency, recipient }) => {
      await authorize();
      const resolvedKey = NotificationKey.parse(key ?? `n-${crypto.randomUUID().slice(0, 8)}`);
      const owner = await sessionOwner(deps, grant.workspaceId, sessionId);
      let member: Member | null = null;
      if (recipient) {
        // Only a session that works for a person can speak for them to others.
        if (!owner) {
          throw new Error(
            "This session works for no person, so it cannot notify other members of the workspace.",
          );
        }
        member = await resolveMember(deps, grant.workspaceId, recipient);
        if (!member) {
          throw new Error(
            `${recipient} is not a member of this workspace (or the name matches more than one member). Use their email.`,
          );
        }
        if (member.subjectId === owner.subjectId) {
          member = null;
        } else if (
          !(await getMemberNotificationsAllowed(deps.db, {
            workspaceId: grant.workspaceId,
            subjectId: member.subjectId,
          }))
        ) {
          throw new Error(
            `${member.label} hasn't allowed other people's agents to notify them in this workspace. They can turn it on in their inbox settings; until then, tell the person you work for instead.`,
          );
        }
      }
      const target = member?.subjectId ?? owner?.subjectId ?? null;
      const existing = target
        ? (
            await listInboxItems(deps.db, {
              accountId: grant.accountId,
              subjectId: target,
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
        ...(member && owner
          ? {
              recipientSubjectId: member.subjectId,
              sender: {
                subjectId: owner.subjectId,
                label: await personLabel(deps, grant.workspaceId, owner.subjectId),
              },
            }
          : {}),
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
        delivered: target !== null,
        ...(member ? { recipient: member.label } : {}),
        updatedInPlace: Boolean(existing),
      });
    },
  );

  server.registerTool(
    "notification_withdraw",
    {
      description:
        "Withdraw a notification this session posted (by its key) once it no longer applies, for example when you are no longer blocked. It leaves the inbox and phone of everyone it reached; pass recipient to withdraw only the copy sent to that member.",
      inputSchema: {
        key: z.string().min(1).max(120),
        recipient: z.string().trim().min(1).max(320).optional(),
      },
    },
    async ({ key, recipient }) => {
      await authorize();
      let recipientSubjectId: string | undefined;
      if (recipient) {
        const member = await resolveMember(deps, grant.workspaceId, recipient);
        // Someone who has since left can still have their copy withdrawn by id.
        recipientSubjectId = member?.subjectId ?? recipient;
      }
      const payload = SessionNotificationWithdrawnPayload.parse({
        key: NotificationKey.parse(key),
        ...(recipientSubjectId ? { recipientSubjectId } : {}),
      });
      await appendOwn([{ type: "session.notification.withdrawn", payload }]);
      return json({ ok: true, key: payload.key });
    },
  );

  server.registerTool(
    "inbox_tidy",
    {
      description:
        "See and look after the inbox of the person this session works for. Lists the open items you may manage: by default the agent notifications from this session and sessions under it; every session's notifications when the person lets any agent tidy; and, when the person gives agents full access, every open item (questions, approvals, paused goals, replies and notifications) with its session, so you can keep them up to date. Pass dismissItemIds to dismiss items that are done, stale or duplicated, snooze to hide items until a time, and unsnoozeItemIds to bring snoozed ones back. Dismissing a question or approval only clears it from the inbox; its session still waits. Never answer a question or decide an approval for the person: tell them, and they settle it.",
      inputSchema: {
        dismissItemIds: z.array(z.string().uuid()).max(50).default([]),
        snooze: z
          .array(
            z.object({
              itemId: z.string().uuid(),
              until: z
                .string()
                .datetime({ offset: true })
                .describe("ISO time to hide the item until"),
            }),
          )
          .max(50)
          .default([]),
        unsnoozeItemIds: z.array(z.string().uuid()).max(50).default([]),
      },
    },
    async ({ dismissItemIds, snooze, unsnoozeItemIds }) => {
      await authorize();
      const owner = await sessionOwner(deps, grant.workspaceId, sessionId);
      if (!owner) {
        return json({ ok: true, items: [], dismissed: [], snoozed: [], unsnoozed: [] });
      }
      const scope = { accountId: grant.accountId, subjectId: owner.subjectId };
      const policy = await getInboxTidyPolicy(deps.db, scope);
      const fullAccess = policy === "full_access";
      const allowed = async (item: InboxItemRow): Promise<boolean> => {
        if (fullAccess) return true;
        if (item.kind !== "notification") return false;
        if (policy === "any_agent") return true;
        return (
          item.workspaceId === grant.workspaceId &&
          (await isSelfOrAncestor(deps, grant.workspaceId, sessionId, item.sessionId))
        );
      };
      const items = await listInboxItems(deps.db, scope);
      const manageable: InboxItemRow[] = [];
      for (const item of items) if (await allowed(item)) manageable.push(item);
      const find = (itemId: string) => manageable.find((candidate) => candidate.id === itemId);
      const dismissed: string[] = [];
      for (const itemId of dismissItemIds) {
        const item = find(itemId);
        if (!item) continue;
        if (item.kind !== "notification") {
          // Clears it from the inbox only; the question or approval stays open in its session.
          if (await updateInboxItemAttention(deps.db, { itemId, ...scope, dismissed: true })) {
            dismissed.push(itemId);
          }
          continue;
        }
        if (await dismissInboxNotification(deps.db, { itemId, ...scope })) {
          dismissed.push(itemId);
          // Record the tidy on the posting session, so its timeline and hosts see it.
          await appendAndPublishEvents(deps.db, deps.bus, item.workspaceId, item.sessionId, [
            {
              type: "session.notification.withdrawn",
              payload: SessionNotificationWithdrawnPayload.parse({
                key: item.sourceKey,
                ...(item.sessionId === sessionId ? {} : { bySessionId: sessionId }),
                // Only this person's copy: the same key may also have reached others.
                recipientSubjectId: owner.subjectId,
              }),
            },
          ] as Parameters<typeof appendAndPublishEvents>[4]);
        }
      }
      const snoozed: Array<{ itemId: string; until: string }> = [];
      for (const { itemId, until } of snooze) {
        if (dismissed.includes(itemId) || !find(itemId)) continue;
        const at = new Date(until);
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
          throw new Error(`Snooze time for ${itemId} must be in the future`);
        }
        const iso = at.toISOString();
        if (await updateInboxItemAttention(deps.db, { itemId, ...scope, snoozedUntil: iso })) {
          snoozed.push({ itemId, until: iso });
        }
      }
      const unsnoozed: string[] = [];
      for (const itemId of unsnoozeItemIds) {
        const item = find(itemId);
        if (!item || dismissed.includes(itemId) || item.snoozedUntil === null) continue;
        if (await updateInboxItemAttention(deps.db, { itemId, ...scope, snoozedUntil: null })) {
          unsnoozed.push(itemId);
        }
      }
      const remaining = manageable.filter((item) => !dismissed.includes(item.id));
      const snoozeOf = (item: InboxItemRow): string | null => {
        if (unsnoozed.includes(item.id)) return null;
        return snoozed.find((each) => each.itemId === item.id)?.until ?? item.snoozedUntil;
      };
      if (!fullAccess) {
        return json({
          ok: true,
          policy,
          dismissed,
          snoozed,
          unsnoozed,
          notifications: remaining.map((item) => ({
            itemId: item.id,
            sessionId: item.sessionId,
            title: item.title,
            message: item.body,
            snoozedUntil: snoozeOf(item),
            updatedAt: item.updatedAt,
          })),
        });
      }
      const titles = new Map<string, string | null>();
      const byWorkspace = new Map<string, string[]>();
      for (const item of remaining) {
        byWorkspace.set(item.workspaceId, [
          ...(byWorkspace.get(item.workspaceId) ?? []),
          item.sessionId,
        ]);
      }
      for (const [workspaceId, sessionIds] of byWorkspace) {
        const found = await getSessionTitles(deps.db, workspaceId, [...new Set(sessionIds)]);
        for (const [id, title] of found) titles.set(id, title);
      }
      return json({
        ok: true,
        policy,
        dismissed,
        snoozed,
        unsnoozed,
        // Needs-you items first, then replies and notes; newest first within each.
        items: [
          ...remaining.filter((item) => needsPerson(item)),
          ...remaining.filter((item) => !needsPerson(item)),
        ].map((item) => ({
          itemId: item.id,
          kind: item.kind,
          needsPerson: needsPerson(item),
          sessionId: item.sessionId,
          sessionTitle: titles.get(item.sessionId) ?? null,
          title: item.title,
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          message: item.body,
          ...(item.facts.length > 0 ? { facts: item.facts } : {}),
          ...(item.choices.length > 0 ? { choices: item.choices.map((each) => each.label) } : {}),
          urgency: item.urgency,
          unread: item.unread,
          snoozedUntil: snoozeOf(item),
          updatedAt: item.updatedAt,
        })),
      });
    },
  );
}
