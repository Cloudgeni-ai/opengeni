import { deriveSessionDisplayTitle, type Session } from "@opengeni/contracts";
import type { SlackHomeBlock } from "./slack-bot";

const ATTENTION_LIMIT = 5;
const ACTIVE_LIMIT = 8;
const RECENT_LIMIT = 5;

const ACTIVE_STATUSES = new Set<Session["status"]>([
  "queued",
  "running",
  "recovering",
  "waiting_capacity",
]);

export type SlackAppHomeOpenedEvent = {
  eventId: string;
  slackTeamId: string;
  slackUserId: string;
  viewHash: string | null;
};

export function slackAppHomeOpenedEvent(payload: unknown): SlackAppHomeOpenedEvent | null {
  const envelope = record(payload);
  const event = record(envelope?.event);
  if (envelope?.type !== "event_callback" || event?.type !== "app_home_opened") return null;
  if (event.tab !== undefined && event.tab !== "home") return null;
  const eventId = boundedId(envelope.event_id, 256);
  const slackTeamId = boundedId(envelope.team_id, 64);
  const slackUserId = boundedId(event.user, 64);
  const viewHash = boundedOptionalId(record(event.view)?.hash, 256);
  if (!eventId || !slackTeamId || !slackUserId) return null;
  return { eventId, slackTeamId, slackUserId, viewHash };
}

/** URL-only App Home buttons are acknowledged but never become Slack commands. */
export function isSlackAppHomeLinkAction(payload: unknown): boolean {
  const envelope = record(payload);
  if (envelope?.type !== "block_actions" || !Array.isArray(envelope.actions)) return false;
  if (envelope.actions.length !== 1) return false;
  const action = record(envelope.actions[0]);
  const actionId = boundedId(action?.action_id, 255);
  if (!actionId) return false;
  return (
    actionId === "opengeni.home.open_all" ||
    actionId === "opengeni.home.connect" ||
    /^opengeni\.home\.open\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      actionId,
    )
  );
}

export function buildSlackAppHomeBlocks(input: {
  sessions: readonly Session[];
  workspaceUrl: string | null;
  sessionUrl: (sessionId: string) => string | null;
  nowMs?: number;
}): SlackHomeBlock[] {
  const nowMs = input.nowMs ?? Date.now();
  const sessions = dedupeSessions(input.sessions);
  const attention = sessions.filter(sessionNeedsAttention).slice(0, ATTENTION_LIMIT);
  const attentionIds = new Set(attention.map((session) => session.id));
  const active = sessions
    .filter((session) => !attentionIds.has(session.id) && sessionIsActive(session))
    .slice(0, ACTIVE_LIMIT);
  const activeIds = new Set(active.map((session) => session.id));
  const recent = sessions
    .filter(
      (session) =>
        !attentionIds.has(session.id) &&
        !activeIds.has(session.id) &&
        (session.status === "idle" || session.status === "cancelled"),
    )
    .slice(0, RECENT_LIMIT);

  const blocks: SlackHomeBlock[] = [
    {
      type: "header",
      block_id: "opengeni_home_header",
      text: { type: "plain_text", text: "Your OpenGeni tasks", emoji: true },
    },
    {
      type: "context",
      block_id: "opengeni_home_context",
      elements: [
        {
          type: "mrkdwn",
          text: "Private to you · refreshed from your current OpenGeni access",
        },
      ],
    },
  ];

  appendSessionGroup(blocks, "Needs your input", attention, input.sessionUrl, nowMs);
  appendSessionGroup(blocks, "Active", active, input.sessionUrl, nowMs);
  appendSessionGroup(blocks, "Recent", recent, input.sessionUrl, nowMs);

  if (attention.length + active.length + recent.length === 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        block_id: "opengeni_home_empty",
        text: {
          type: "mrkdwn",
          text: "*You're all caught up.*\nNo active or recent tasks are visible to this account.",
        },
      },
    );
  }
  if (input.workspaceUrl) {
    blocks.push({
      type: "actions",
      block_id: "opengeni_home_actions",
      elements: [
        {
          type: "button",
          action_id: "opengeni.home.open_all",
          text: { type: "plain_text", text: "Open OpenGeni", emoji: true },
          url: input.workspaceUrl,
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

export function buildSlackAppHomeAccessBlocks(input: {
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string | null;
}): SlackHomeBlock[] {
  const blocks: SlackHomeBlock[] = [
    {
      type: "header",
      block_id: "opengeni_home_header",
      text: { type: "plain_text", text: "OpenGeni", emoji: true },
    },
    {
      type: "section",
      block_id: "opengeni_home_access",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackMrkdwn(input.title)}*\n${escapeSlackMrkdwn(input.message)}`,
      },
    },
  ];
  if (input.actionUrl) {
    blocks.push({
      type: "actions",
      block_id: "opengeni_home_access_actions",
      elements: [
        {
          type: "button",
          action_id: "opengeni.home.connect",
          text: {
            type: "plain_text",
            text: input.actionLabel?.slice(0, 75) || "Open OpenGeni",
            emoji: true,
          },
          url: input.actionUrl,
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

function appendSessionGroup(
  blocks: SlackHomeBlock[],
  heading: string,
  sessions: readonly Session[],
  sessionUrl: (sessionId: string) => string | null,
  nowMs: number,
): void {
  if (sessions.length === 0) return;
  blocks.push(
    { type: "divider" },
    {
      type: "section",
      block_id: `opengeni_home_group_${heading.toLowerCase().replaceAll(" ", "_")}`,
      text: { type: "mrkdwn", text: `*${heading}*` },
    },
  );
  for (const session of sessions) {
    const url = sessionUrl(session.id);
    const title = deriveSessionDisplayTitle(session).slice(0, 180);
    blocks.push({
      type: "section",
      block_id: `opengeni_home_session_${session.id}`,
      text: {
        type: "plain_text",
        text: `${title}\n${statusLabel(session)} · ${relativeUpdatedAt(session.updatedAt, nowMs)}`,
        emoji: true,
      },
      ...(url
        ? {
            accessory: {
              type: "button",
              action_id: `opengeni.home.open.${session.id}`,
              text: { type: "plain_text", text: "Open", emoji: true },
              url,
            },
          }
        : {}),
    });
  }
}

function dedupeSessions(sessions: readonly Session[]): Session[] {
  const seen = new Set<string>();
  return [...sessions]
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    )
    .filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
}

function sessionNeedsAttention(session: Session): boolean {
  return (
    session.status === "requires_action" ||
    session.status === "failed" ||
    (session.treeStats?.attentionDescendants ?? 0) > 0 ||
    (session.treeStats?.failedDescendants ?? 0) > 0
  );
}

function sessionIsActive(session: Session): boolean {
  return (
    ACTIVE_STATUSES.has(session.status) ||
    (session.treeStats?.runningDescendants ?? 0) > 0 ||
    (session.treeStats?.queuedDescendants ?? 0) > 0
  );
}

function statusLabel(session: Session): string {
  if ((session.treeStats?.attentionDescendants ?? 0) > 0) return "A child task needs input";
  if ((session.treeStats?.failedDescendants ?? 0) > 0) return "A child task needs review";
  if ((session.treeStats?.runningDescendants ?? 0) > 0) return "Child task running";
  if ((session.treeStats?.queuedDescendants ?? 0) > 0) return "Child task queued";
  switch (session.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "requires_action":
      return "Approval or answer needed";
    case "recovering":
      return "Recovering";
    case "waiting_capacity":
      return "Waiting for capacity";
    case "idle":
      return "Completed";
    case "failed":
      return "Needs review";
    case "cancelled":
      return "Cancelled";
  }
}

function relativeUpdatedAt(value: string, nowMs: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently updated";
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "updated now";
  if (elapsedMinutes < 60) return `updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `updated ${elapsedHours}h ago`;
  return `updated ${Math.floor(elapsedHours / 24)}d ago`;
}

export function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function boundedId(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function boundedOptionalId(value: unknown, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedId(value, maxBytes);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
