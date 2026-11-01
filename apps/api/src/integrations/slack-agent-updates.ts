/**
 * Occasional update messages about Slack agents.
 *
 * Opengeni sends a linked Slack person a short direct message only when
 * something is new for them: a welcome right after they link Slack, one
 * message when there are agents they can use and haven't heard of, or one
 * reminder after 60 days without using any agent. At most one message per
 * person per 30 days (the welcome starts the clock), on a weekday at 10:00 in
 * their own Slack time zone. An organization admin turns this on per Slack
 * installation; it is off by default.
 *
 * Every message is recorded with a deterministic operation id before it is
 * posted through the Slack post-operation ledger, so a retry never sends twice
 * and the limits hold across processes.
 */
import { createHash } from "node:crypto";

import { slackAgentHandle } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  claimSlackAgentUpdateDelivery,
  claimSlackAgentUpdateSweep,
  finishSlackAgentUpdateSweep,
  getSlackBotUserLink,
  listNamedSubjectSlackRoutableWorkspaces,
  listPendingSlackAgentUpdateDeliveries,
  listSlackAgentsForConnection,
  listSlackAgentUpdateSweepInstallations,
  listSlackInstallationBindings,
  loadSlackAgentUpdateAudience,
  markSlackAgentUpdateDeliveryFailed,
  markSlackAgentUpdateDeliverySent,
  resolveSlackInstallationRoute,
  saveSlackAgentUpdateRecipientProfile,
  setSlackBotUserUpdatesMuted,
  SLACK_AGENT_UPDATE_MIN_GAP_MS,
  type SlackAgentRecord,
  type SlackAgentUpdateAudienceMember,
  type SlackAgentUpdateDeliveryRecord,
  type SlackAgentUpdateKind,
  type SlackAgentUpdateProfileState,
  type SlackAgentUpdateRecipientRecord,
} from "@opengeni/db";

import { escapeSlackMrkdwn } from "./slack-app-home";
import {
  createOpenGeniSlackBotInteractionClient,
  SlackBotProviderError,
  type OpenGeniSlackBotClient,
  type SlackMessageBlock,
} from "./slack-bot";

export const SLACK_AGENT_UPDATE_HOME_ACTION_ID = "opengeni.updates.home";
export const SLACK_AGENT_UPDATE_MUTE_ACTION_ID = "opengeni.updates.mute";
export const SLACK_AGENT_UPDATE_UNMUTE_ACTION_ID = "opengeni.updates.unmute";
const SLACK_AGENT_UPDATE_ACTIONS_BLOCK_ID = "opengeni_updates_actions";
const SLACK_AGENT_UPDATE_TEXT_BLOCK_ID = "opengeni_updates_text";
const SLACK_AGENT_UPDATE_MUTED_BLOCK_ID = "opengeni_updates_muted";

/** Provider calls on behalf of the sweeper and the buttons. */
export const SLACK_AGENT_UPDATE_SUBJECT_ID = "service:slack-interaction";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** A welcome goes out only to people who linked Slack within this long. */
const WELCOME_WINDOW_MS = DAY_MS;
/** Without using any agent for this long, a person gets one reminder. */
export const SLACK_AGENT_UPDATE_DORMANT_MS = 60 * DAY_MS;
/** Cached Slack profile facts (time zone, guest, external, active) are refreshed after this. */
const PROFILE_TTL_MS = DAY_MS;
/** Local send hour, Monday to Friday. The whole hour is the tolerance window. */
export const SLACK_AGENT_UPDATE_LOCAL_HOUR = 10;
/** Agents named by name in one message; the rest are "N more". */
const NAMED_AGENTS = 2;

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export type SlackAgentUpdateAgent = Pick<SlackAgentRecord, "id" | "name" | "description">;

/** Opens the Opengeni app's Home tab, where every agent is listed. */
export function slackAgentUpdateHomeUrl(input: { slackTeamId: string; appId: string }): string {
  return `slack://app?team=${encodeURIComponent(input.slackTeamId)}&id=${encodeURIComponent(input.appId)}&tab=home`;
}

function agentNames(agents: readonly SlackAgentUpdateAgent[]): string {
  const named = agents.slice(0, NAMED_AGENTS).map((agent) => `*${escapeSlackMrkdwn(agent.name)}*`);
  const more = agents.length - named.length;
  if (more > 0) return `${named.join(", ")} and ${more} more`;
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return named[0] ?? "";
}

function plainAgentNames(agents: readonly SlackAgentUpdateAgent[]): string {
  const named = agents.slice(0, NAMED_AGENTS).map((agent) => agent.name);
  const more = agents.length - named.length;
  if (more > 0) return `${named.join(", ")} and ${more} more`;
  return named.join(" and ");
}

/**
 * One update message: at most three lines of text and one row of two buttons,
 * sent as Opengeni. Never empty: callers pass at least one agent.
 */
export function buildSlackAgentUpdateMessage(input: {
  kind: SlackAgentUpdateKind;
  agents: readonly SlackAgentUpdateAgent[];
  botUserId: string | null;
  homeUrl: string;
  /** Carried by the mute button; the delivery id, or "preview". */
  muteValue: string;
}): { text: string; blocks: SlackMessageBlock[] } {
  const agents = input.agents;
  const first = agents[0];
  if (!first) throw new Error("an update message names at least one agent");
  const mention = input.botUserId ? `<@${input.botUserId}>` : "@Opengeni";
  const call = `${mention} +${slackAgentHandle(first.name)}`;
  const single = agents.length === 1;
  const lines: string[] = [];
  let text: string;
  if (input.kind === "welcome") {
    lines.push("Welcome to Opengeni in Slack.");
    lines.push(
      single
        ? `You can ask *${escapeSlackMrkdwn(first.name)}*: ${escapeSlackMrkdwn(first.description)}`
        : `Agents you can ask: ${agentNames(agents)}.`,
    );
    lines.push(`${single ? "Ask it" : "Try one"} with ${call}`);
    text = `Welcome to Opengeni in Slack. Agents you can ask: ${plainAgentNames(agents)}.`;
  } else if (input.kind === "update") {
    lines.push(
      single
        ? `New agent you can ask: *${escapeSlackMrkdwn(first.name)}*. ${escapeSlackMrkdwn(first.description)}`
        : `New agents you can ask: ${agentNames(agents)}.`,
    );
    lines.push(`${single ? "Ask it" : "Try one"} with ${call}`);
    text = `New ${single ? "agent" : "agents"} you can ask: ${plainAgentNames(agents)}.`;
  } else {
    lines.push(
      single
        ? `*${escapeSlackMrkdwn(first.name)}* is here when you need it. ${escapeSlackMrkdwn(first.description)}`
        : `Agents you can ask in Slack: ${agentNames(agents)}.`,
    );
    lines.push(`${single ? "Ask it" : "Try one"} with ${call}`);
    text = `Agents you can ask in Slack: ${plainAgentNames(agents)}.`;
  }
  return {
    text,
    blocks: [
      {
        type: "section",
        block_id: SLACK_AGENT_UPDATE_TEXT_BLOCK_ID,
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      slackAgentUpdateActions(input.homeUrl, {
        actionId: SLACK_AGENT_UPDATE_MUTE_ACTION_ID,
        label: "Mute updates",
        value: input.muteValue,
      }),
    ],
  };
}

function slackAgentUpdateActions(
  homeUrl: string | null,
  toggle: { actionId: string; label: string; value: string },
): SlackMessageBlock {
  return {
    type: "actions",
    block_id: SLACK_AGENT_UPDATE_ACTIONS_BLOCK_ID,
    elements: [
      ...(homeUrl
        ? [
            {
              type: "button" as const,
              action_id: SLACK_AGENT_UPDATE_HOME_ACTION_ID,
              value: "home",
              text: { type: "plain_text" as const, text: "See all agents" },
              url: homeUrl,
            },
          ]
        : []),
      {
        type: "button" as const,
        action_id: toggle.actionId,
        value: toggle.value.slice(0, 64) || "update",
        text: { type: "plain_text" as const, text: toggle.label },
      },
    ],
  };
}

/**
 * The same message after its mute button was pressed (or undone): the text
 * stays, "Updates muted." is added and the button becomes Undo, or the other
 * way round.
 */
export function buildSlackAgentUpdateMuteConfirmation(input: {
  /** The section text of the message as Slack sent it back. */
  messageText: string;
  homeUrl: string | null;
  muted: boolean;
  value: string;
}): SlackMessageBlock[] {
  return [
    {
      type: "section",
      block_id: SLACK_AGENT_UPDATE_TEXT_BLOCK_ID,
      text: { type: "mrkdwn", text: input.messageText.slice(0, 2_000) || "Opengeni" },
    },
    ...(input.muted
      ? [
          {
            type: "context" as const,
            block_id: SLACK_AGENT_UPDATE_MUTED_BLOCK_ID,
            elements: [{ type: "mrkdwn" as const, text: "Updates muted." }],
          },
        ]
      : []),
    slackAgentUpdateActions(
      input.homeUrl,
      input.muted
        ? { actionId: SLACK_AGENT_UPDATE_UNMUTE_ACTION_ID, label: "Undo", value: input.value }
        : {
            actionId: SLACK_AGENT_UPDATE_MUTE_ACTION_ID,
            label: "Mute updates",
            value: input.value,
          },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export type SlackLocalTime = {
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  hour: number;
  /** The local calendar date, `YYYY-MM-DD`. */
  date: string;
};

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Local wall-clock time for a Slack person, from their IANA time zone
 * (`users.info` `tz`), falling back to `tz_offset` seconds. Null when Slack
 * gave neither.
 */
export function slackLocalTime(
  now: Date,
  tz: string | null | undefined,
  tzOffset: number | null | undefined,
): SlackLocalTime | null {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
      const weekday = WEEKDAYS[part("weekday")];
      const hour = Number(part("hour"));
      if (weekday && Number.isInteger(hour)) {
        return { weekday, hour, date: `${part("year")}-${part("month")}-${part("day")}` };
      }
    } catch {
      // Unknown time zone name: use the offset.
    }
  }
  if (typeof tzOffset === "number" && Number.isFinite(tzOffset)) {
    const shifted = new Date(now.getTime() + tzOffset * 1_000);
    const day = shifted.getUTCDay();
    return {
      weekday: day === 0 ? 7 : day,
      hour: shifted.getUTCHours(),
      date: shifted.toISOString().slice(0, 10),
    };
  }
  return null;
}

/** Monday to Friday, 10:00 to 10:59 local time. */
export function inSlackAgentUpdateWindow(local: SlackLocalTime | null): boolean {
  return Boolean(
    local &&
    local.weekday >= 1 &&
    local.weekday <= 5 &&
    local.hour === SLACK_AGENT_UPDATE_LOCAL_HOUR,
  );
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type SlackAgentUpdateProfile = {
  state: SlackAgentUpdateProfileState;
  tz: string | null;
  tzOffset: number | null;
};

export type SlackAgentUpdateDecision =
  | {
      send: true;
      kind: SlackAgentUpdateKind;
      agents: SlackAgentRecord[];
      dedupeKey: string;
      dormantSince: Date | null;
      alsoDormantReminder: boolean;
    }
  | {
      send: false;
      reason:
        | "muted"
        | "not_eligible"
        | "no_agents"
        | "too_soon"
        | "outside_window"
        | "nothing_new";
    };

/** When a person last did anything that counts: used an agent, or linked Slack. */
export function slackAgentDormantSince(member: { linkedAt: Date }, lastUsedAt: Date | null): Date {
  return lastUsedAt && lastUsedAt.getTime() > member.linkedAt.getTime()
    ? lastUsedAt
    : member.linkedAt;
}

/**
 * Whether one linked person gets a message now, and which. Pure: every fact
 * is passed in, and the durable claim checks the limits again under a lock.
 */
export function selectSlackAgentUpdate(input: {
  now: Date;
  updatesEnabledAt: Date | null;
  member: Pick<SlackAgentUpdateAudienceMember, "slackUserId" | "linkedAt" | "updatesMutedAt">;
  recipient: SlackAgentUpdateRecipientRecord | undefined;
  profile: SlackAgentUpdateProfile;
  /** Agents this person can start work with, in directory order. */
  usableAgents: readonly SlackAgentRecord[];
  usedAgentIds: ReadonlySet<string>;
  lastUsedAt: Date | null;
}): SlackAgentUpdateDecision {
  const { now, member, recipient, profile } = input;
  const nowMs = now.getTime();
  if (member.updatesMutedAt) return { send: false, reason: "muted" };
  if (profile.state !== "eligible") return { send: false, reason: "not_eligible" };
  if (input.usableAgents.length === 0) return { send: false, reason: "no_agents" };
  const unused = input.usableAgents.filter((agent) => !input.usedAgentIds.has(agent.id));
  if (
    !recipient?.welcomeSentAt &&
    input.updatesEnabledAt &&
    member.linkedAt.getTime() >= input.updatesEnabledAt.getTime() &&
    nowMs - member.linkedAt.getTime() <= WELCOME_WINDOW_MS
  ) {
    return {
      send: true,
      kind: "welcome",
      agents: unused.length > 0 ? unused : [...input.usableAgents],
      dedupeKey: `${member.slackUserId}:welcome`,
      dormantSince: null,
      alsoDormantReminder: false,
    };
  }
  if (
    recipient?.lastSentAt &&
    nowMs - recipient.lastSentAt.getTime() < SLACK_AGENT_UPDATE_MIN_GAP_MS
  ) {
    return { send: false, reason: "too_soon" };
  }
  const local = slackLocalTime(now, profile.tz, profile.tzOffset);
  if (!inSlackAgentUpdateWindow(local)) return { send: false, reason: "outside_window" };
  const dormantSince = slackAgentDormantSince(member, input.lastUsedAt);
  const dormant =
    nowMs - dormantSince.getTime() >= SLACK_AGENT_UPDATE_DORMANT_MS &&
    !(recipient?.dormantSentAt && recipient.dormantSentAt.getTime() >= dormantSince.getTime());
  const announced = new Set(recipient?.announcedAgentIds ?? []);
  const fresh = unused.filter((agent) => !announced.has(agent.id));
  if (fresh.length > 0) {
    return {
      send: true,
      kind: "update",
      agents: fresh,
      dedupeKey: `${member.slackUserId}:update:${local!.date}`,
      dormantSince: dormant ? dormantSince : null,
      alsoDormantReminder: dormant,
    };
  }
  if (dormant) {
    return {
      send: true,
      kind: "dormant",
      agents: unused.length > 0 ? unused : [...input.usableAgents],
      dedupeKey: `${member.slackUserId}:dormant:${local!.date}`,
      dormantSince,
      alsoDormantReminder: false,
    };
  }
  return { send: false, reason: "nothing_new" };
}

/**
 * Cheap check before any Slack or membership lookup: could this person get
 * anything at all now? False is final for this sweep.
 */
function mightSend(input: {
  now: Date;
  updatesEnabledAt: Date | null;
  member: SlackAgentUpdateAudienceMember;
  recipient: SlackAgentUpdateRecipientRecord | undefined;
  agentIds: readonly string[];
  usedAgentIds: ReadonlySet<string>;
  lastUsedAt: Date | null;
}): boolean {
  const { now, member, recipient } = input;
  const nowMs = now.getTime();
  if (member.updatesMutedAt) return false;
  if (
    recipient?.profileState &&
    recipient.profileState !== "eligible" &&
    recipient.profileCheckedAt &&
    nowMs - recipient.profileCheckedAt.getTime() < PROFILE_TTL_MS
  ) {
    return false;
  }
  if (
    !recipient?.welcomeSentAt &&
    input.updatesEnabledAt &&
    member.linkedAt.getTime() >= input.updatesEnabledAt.getTime() &&
    nowMs - member.linkedAt.getTime() <= WELCOME_WINDOW_MS
  ) {
    return true;
  }
  if (
    recipient?.lastSentAt &&
    nowMs - recipient.lastSentAt.getTime() < SLACK_AGENT_UPDATE_MIN_GAP_MS
  ) {
    return false;
  }
  if (
    recipient?.profileCheckedAt &&
    nowMs - recipient.profileCheckedAt.getTime() < PROFILE_TTL_MS &&
    !inSlackAgentUpdateWindow(slackLocalTime(now, recipient.tz, recipient.tzOffset))
  ) {
    return false;
  }
  const announced = new Set(recipient?.announcedAgentIds ?? []);
  if (input.agentIds.some((id) => !input.usedAgentIds.has(id) && !announced.has(id))) return true;
  const dormantSince = slackAgentDormantSince(member, input.lastUsedAt);
  return (
    nowMs - dormantSince.getTime() >= SLACK_AGENT_UPDATE_DORMANT_MS &&
    !(recipient?.dormantSentAt && recipient.dormantSentAt.getTime() >= dormantSince.getTime())
  );
}

function profileState(facts: {
  deleted: boolean;
  isBot: boolean;
  isGuest: boolean;
  isExternal: boolean;
}): SlackAgentUpdateProfileState {
  if (facts.deleted) return "deactivated";
  if (facts.isBot) return "bot";
  if (facts.isGuest) return "guest";
  if (facts.isExternal) return "external";
  return "eligible";
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Slack errors that will not change by retrying this message. */
const PERMANENT_POST_ERRORS = new Set([
  "user_not_found",
  "user_disabled",
  "account_inactive",
  "cannot_dm_bot",
  "channel_not_found",
  "is_archived",
  "messages_tab_disabled",
  "not_allowed_token_type",
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "invalid_blocks",
  "restricted_action",
  "ekm_access_denied",
  "team_access_not_granted",
  "slack_bot_operation_conflict",
]);
const MAX_ATTEMPTS = 5;

function errorCode(error: unknown): string {
  if (error instanceof SlackBotProviderError) return error.code;
  if (error instanceof Error && error.name === "SlackBotOperationConflictError") {
    return "slack_bot_operation_conflict";
  }
  return "local_error";
}

const appIds = new Map<string, string>();

/** The installed Slack app's id (for the Home tab link), read once per installation. */
async function slackAppIdFor(
  client: OpenGeniSlackBotClient,
  connectionId: string,
  botUserId: string,
): Promise<string | null> {
  const cached = appIds.get(connectionId);
  if (cached) return cached;
  const facts = await client.userProfileFacts(botUserId);
  if (!facts.apiAppId) return null;
  appIds.set(connectionId, facts.apiAppId);
  return facts.apiAppId;
}

/** Forget cached app ids (tests). */
export function resetSlackAgentUpdateCaches(): void {
  appIds.clear();
}

type SweepHome = { accountId: string; workspaceId: string };

async function sendDelivery(
  deps: Pick<ApiRouteDeps, "db">,
  home: SweepHome,
  client: OpenGeniSlackBotClient,
  delivery: SlackAgentUpdateDeliveryRecord,
  now: Date,
): Promise<"sent" | "failed" | "retry" | "rate_limited"> {
  try {
    const posted = await client.postMessage({
      operationId: delivery.operationId,
      userId: delivery.slackUserId,
      text: delivery.text,
      blocks: delivery.blocks as SlackMessageBlock[],
    });
    await markSlackAgentUpdateDeliverySent(deps.db, home, {
      deliveryId: delivery.id,
      slackChannelId: posted.channelId,
      slackMessageTs: posted.timestamp,
    });
    return "sent";
  } catch (error) {
    const code = errorCode(error);
    if (code === "rate_limited") {
      const retryAfterMs =
        error instanceof SlackBotProviderError ? (error.retryAfterMs ?? 60_000) : 60_000;
      await markSlackAgentUpdateDeliveryFailed(deps.db, home, {
        deliveryId: delivery.id,
        errorCode: code,
        retryAt: new Date(now.getTime() + Math.max(1_000, retryAfterMs)),
      });
      return "rate_limited";
    }
    const permanent = PERMANENT_POST_ERRORS.has(code) || delivery.attempts + 1 >= MAX_ATTEMPTS;
    await markSlackAgentUpdateDeliveryFailed(deps.db, home, {
      deliveryId: delivery.id,
      errorCode: code,
      retryAt: permanent
        ? null
        : new Date(now.getTime() + 60_000 * 2 ** Math.min(6, delivery.attempts)),
    });
    return permanent ? "failed" : "retry";
  }
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

export type SlackAgentUpdateSweepOptions = {
  now?: () => Date;
  /** Installations looked at per tick. */
  maxInstallations?: number;
  /** Messages sent per installation per sweep. */
  maxSendsPerInstallation?: number;
  /** `users.info` lookups per installation per sweep. */
  maxProfileLookupsPerInstallation?: number;
  /** One installation is swept at most this often. */
  installationIntervalMs?: number;
};

export type SlackAgentUpdateSweepResult = {
  installations: number;
  sent: number;
  failed: number;
};

/**
 * One pass over every installation that has update messages on. Bounded per
 * installation, and an installation stops at Slack's first rate limit.
 */
export async function sweepSlackAgentUpdatesOnce(
  deps: ApiRouteDeps,
  options: SlackAgentUpdateSweepOptions = {},
): Promise<SlackAgentUpdateSweepResult> {
  const result: SlackAgentUpdateSweepResult = { installations: 0, sent: 0, failed: 0 };
  if (!deps.settings.slackWorkspaceRoutingEnabled) return result;
  const installations = await listSlackAgentUpdateSweepInstallations(deps.db, {
    limit: options.maxInstallations ?? 20,
  });
  for (const installation of installations) {
    const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };
    const holder = crypto.randomUUID();
    const claimed = await claimSlackAgentUpdateSweep(deps.db, home, {
      connectionId: installation.connectionId,
      holder,
      leaseMs: 5 * 60_000,
      minIntervalMs: options.installationIntervalMs ?? 2 * 60_000,
    });
    if (!claimed) continue;
    result.installations += 1;
    try {
      const swept = await sweepInstallation(deps, installation, options);
      result.sent += swept.sent;
      result.failed += swept.failed;
    } catch (error) {
      deps.observability?.error("Slack agent update sweep failed", {
        errorClass: error instanceof Error ? error.name : "SlackAgentUpdateSweepError",
        errorCode: errorCode(error),
        origin: "api",
      });
    } finally {
      await finishSlackAgentUpdateSweep(deps.db, home, {
        connectionId: installation.connectionId,
        holder,
      }).catch(() => undefined);
    }
  }
  return result;
}

async function sweepInstallation(
  deps: ApiRouteDeps,
  installation: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    updatesEnabledAt: Date | null;
  },
  options: SlackAgentUpdateSweepOptions,
): Promise<{ sent: number; failed: number }> {
  const now = options.now?.() ?? new Date();
  const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };
  const connectionId = installation.connectionId;
  const counts = { sent: 0, failed: 0 };
  let sendBudget = Math.max(1, options.maxSendsPerInstallation ?? 25);
  let lookupBudget = Math.max(1, options.maxProfileLookupsPerInstallation ?? 40);
  const binding = (await listSlackInstallationBindings(deps.db, home)).find(
    (candidate) => candidate.connectionId === connectionId && candidate.state === "active",
  );
  if (!binding) return counts;
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    ...home,
    connectionId,
    subjectId: SLACK_AGENT_UPDATE_SUBJECT_ID,
  });

  // Retries first: messages already recorded go out under their own ids.
  for (const delivery of await listPendingSlackAgentUpdateDeliveries(deps.db, home, {
    connectionId,
    now,
    limit: sendBudget,
  })) {
    // Someone who muted updates, or unlinked, since this was recorded gets
    // nothing more: the retry is dropped, never sent.
    const link = await getSlackBotUserLink(
      deps.db,
      home.workspaceId,
      connectionId,
      delivery.slackUserId,
    );
    if (!link || link.updatesMutedAt) {
      await markSlackAgentUpdateDeliveryFailed(deps.db, home, {
        deliveryId: delivery.id,
        errorCode: link ? "muted" : "unlinked",
        retryAt: null,
      });
      continue;
    }
    sendBudget -= 1;
    const outcome = await sendDelivery(deps, home, client, delivery, now);
    if (outcome === "sent") counts.sent += 1;
    if (outcome === "failed") counts.failed += 1;
    if (outcome === "rate_limited") return counts;
  }
  if (sendBudget <= 0) return counts;

  const agents = await listSlackAgentsForConnection(deps.db, home, { connectionId });
  if (agents.length === 0) return counts;
  const agentIds = agents.map((agent) => agent.id);
  const audience = await loadSlackAgentUpdateAudience(deps.db, home, { connectionId });
  const usesByUser = new Map<string, { used: Set<string>; lastUsedAt: Date | null }>();
  for (const use of audience.uses) {
    const entry = usesByUser.get(use.slackUserId) ?? { used: new Set<string>(), lastUsedAt: null };
    entry.used.add(use.slackAgentId);
    if (!entry.lastUsedAt || use.lastUsedAt.getTime() > entry.lastUsedAt.getTime()) {
      entry.lastUsedAt = use.lastUsedAt;
    }
    usesByUser.set(use.slackUserId, entry);
  }
  const reachableBySubject = new Map<string, Set<string>>();
  let homeUrl: string | null | undefined;

  for (const member of audience.members) {
    if (sendBudget <= 0) break;
    const uses = usesByUser.get(member.slackUserId);
    const usedAgentIds = uses?.used ?? new Set<string>();
    const lastUsedAt = uses?.lastUsedAt ?? null;
    let recipient = audience.recipients.get(member.slackUserId);
    if (
      !mightSend({
        now,
        updatesEnabledAt: installation.updatesEnabledAt,
        member,
        recipient,
        agentIds,
        usedAgentIds,
        lastUsedAt,
      })
    ) {
      continue;
    }
    try {
      if (
        !recipient?.profileCheckedAt ||
        !recipient.profileState ||
        now.getTime() - recipient.profileCheckedAt.getTime() >= PROFILE_TTL_MS
      ) {
        if (lookupBudget <= 0) continue;
        lookupBudget -= 1;
        let state: SlackAgentUpdateProfileState;
        let tz: string | null = null;
        let tzOffset: number | null = null;
        try {
          const facts = await client.userProfileFacts(member.slackUserId);
          state = profileState(facts);
          tz = facts.tz;
          tzOffset = facts.tzOffset;
        } catch (error) {
          const code = errorCode(error);
          if (code === "user_not_found" || code === "account_inactive") state = "deactivated";
          else throw error;
        }
        recipient = await saveSlackAgentUpdateRecipientProfile(deps.db, home, {
          connectionId,
          slackUserId: member.slackUserId,
          tz,
          tzOffset,
          profileState: state,
          checkedAt: now,
        });
      }
      let reachable = reachableBySubject.get(member.subjectId);
      if (!reachable) {
        reachable = new Set(
          (
            await listNamedSubjectSlackRoutableWorkspaces(deps.db, {
              accountId: home.accountId,
              subjectId: member.subjectId,
            })
          ).map((workspace) => workspace.workspaceId),
        );
        reachableBySubject.set(member.subjectId, reachable);
      }
      const usableAgents = agents.filter((agent) => reachable.has(agent.targetWorkspaceId));
      const decision = selectSlackAgentUpdate({
        now,
        updatesEnabledAt: installation.updatesEnabledAt,
        member,
        recipient,
        profile: {
          state: recipient.profileState ?? "eligible",
          tz: recipient.tz,
          tzOffset: recipient.tzOffset,
        },
        usableAgents,
        usedAgentIds,
        lastUsedAt,
      });
      if (!decision.send) continue;
      if (homeUrl === undefined) {
        const appId = await slackAppIdFor(client, connectionId, binding.botUserId);
        homeUrl = appId
          ? slackAgentUpdateHomeUrl({ slackTeamId: binding.slackTeamId, appId })
          : null;
      }
      if (!homeUrl) return counts;
      const operationId = deterministicUuid(
        `slack-agent-update:${connectionId}:${decision.dedupeKey}`,
      );
      const message = buildSlackAgentUpdateMessage({
        kind: decision.kind,
        agents: decision.agents,
        botUserId: binding.botUserId,
        homeUrl,
        muteValue: operationId,
      });
      const claim = await claimSlackAgentUpdateDelivery(deps.db, home, {
        connectionId,
        slackUserId: member.slackUserId,
        kind: decision.kind,
        dedupeKey: decision.dedupeKey,
        operationId,
        agentIds: decision.agents.map((agent) => agent.id),
        text: message.text,
        blocks: message.blocks,
        now,
        dormantSince: decision.dormantSince,
        alsoDormantReminder: decision.alsoDormantReminder,
      });
      if (claim.kind !== "claimed") continue;
      sendBudget -= 1;
      const outcome = await sendDelivery(deps, home, client, claim.delivery, now);
      if (outcome === "sent") counts.sent += 1;
      if (outcome === "failed") counts.failed += 1;
      if (outcome === "rate_limited") return counts;
    } catch (error) {
      if (errorCode(error) === "rate_limited") return counts;
      throw error;
    }
  }
  return counts;
}

/**
 * Sweep for update messages every `intervalMs` (default one minute). Returns
 * an async stop that waits for a running sweep.
 */
export function startSlackAgentUpdatePump(
  deps: ApiRouteDeps,
  options: SlackAgentUpdateSweepOptions & { intervalMs?: number } = {},
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
  const tick = () => {
    if (stopped || running) return;
    running = sweepSlackAgentUpdatesOnce(deps, options)
      .then(() => undefined)
      .catch((error) => {
        deps.observability?.error("Slack agent update sweep failed", {
          errorClass: error instanceof Error ? error.name : "SlackAgentUpdatePumpError",
          errorCode: errorCode(error),
          origin: "api",
        });
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedId(value: unknown, max: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : "";
}

/** Whether a Slack block action is one of the update-message buttons. */
export function isSlackAgentUpdateAction(payload: unknown): boolean {
  const envelope = record(payload);
  if (envelope?.type !== "block_actions" || !Array.isArray(envelope.actions)) return false;
  if (envelope.actions.length !== 1) return false;
  const actionId = boundedId(record(envelope.actions[0])?.action_id, 255);
  return (
    actionId === SLACK_AGENT_UPDATE_HOME_ACTION_ID ||
    actionId === SLACK_AGENT_UPDATE_MUTE_ACTION_ID ||
    actionId === SLACK_AGENT_UPDATE_UNMUTE_ACTION_ID
  );
}

/** The section text and Home link of an update message, from Slack's copy of it. */
function messageParts(message: Record<string, unknown> | null): {
  text: string;
  homeUrl: string | null;
} {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  let text = "";
  let homeUrl: string | null = null;
  for (const value of blocks) {
    const block = record(value);
    if (!block) continue;
    if (block.type === "section" && !text) {
      const raw = record(block.text)?.text;
      if (typeof raw === "string") text = raw.slice(0, 2_000);
    }
    if (block.type === "actions" && Array.isArray(block.elements)) {
      for (const element of block.elements) {
        const button = record(element);
        if (
          button?.action_id === SLACK_AGENT_UPDATE_HOME_ACTION_ID &&
          typeof button.url === "string" &&
          /^slack:\/\/app\?/u.test(button.url) &&
          button.url.length <= 512
        ) {
          homeUrl = button.url;
        }
      }
    }
  }
  if (!text && typeof message?.text === "string") text = message.text.slice(0, 2_000);
  return { text, homeUrl };
}

/**
 * Handle one update-message button. "See all agents" is a link Slack opens by
 * itself. "Mute updates" mutes this Slack person's update messages and turns
 * the message into a short confirmation with Undo; Undo unmutes. The mute is
 * kept even when the confirmation edit fails.
 */
export async function handleSlackAgentUpdateAction(
  deps: ApiRouteDeps,
  payload: unknown,
): Promise<{ ok: true }> {
  const envelope = record(payload);
  const action = record(Array.isArray(envelope?.actions) ? envelope.actions[0] : null);
  const actionId = boundedId(action?.action_id, 255);
  if (actionId === SLACK_AGENT_UPDATE_HOME_ACTION_ID) return { ok: true };
  const teamId = boundedId(record(envelope?.team)?.id, 64);
  const userId = boundedId(record(envelope?.user)?.id, 64);
  const channelId = boundedId(record(envelope?.channel)?.id, 64);
  const message = record(envelope?.message);
  const messageTs = boundedId(message?.ts, 64);
  const actionTs = boundedId(action?.action_ts, 64);
  const value = boundedId(action?.value, 64) || "update";
  if (!teamId || !userId) return { ok: true };
  const installation = await resolveSlackInstallationRoute(deps.db, teamId);
  if (!installation) return { ok: true };
  const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };
  const muted = actionId === SLACK_AGENT_UPDATE_MUTE_ACTION_ID;
  await setSlackBotUserUpdatesMuted(deps.db, home, {
    connectionId: installation.connectionId,
    slackUserId: userId,
    muted,
  });
  if (!channelId || !messageTs) return { ok: true };
  try {
    const parts = messageParts(message);
    const blocks = buildSlackAgentUpdateMuteConfirmation({
      messageText: parts.text,
      homeUrl: parts.homeUrl,
      muted,
      value,
    });
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      ...home,
      connectionId: installation.connectionId,
      subjectId: SLACK_AGENT_UPDATE_SUBJECT_ID,
    });
    await client.updateMessage({
      operationId: deterministicUuid(
        `slack-agent-update-${muted ? "mute" : "unmute"}:${installation.connectionId}:${channelId}:${messageTs}:${actionTs}`,
      ),
      channelId,
      timestamp: messageTs,
      text: muted ? "Updates muted." : parts.text || "Updates on.",
      blocks,
    });
  } catch (error) {
    deps.observability?.error("Slack agent update confirmation failed", {
      errorClass: error instanceof Error ? error.name : "SlackAgentUpdateConfirmationError",
      errorCode: errorCode(error),
      origin: "api",
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export class SlackAgentUpdatePreviewUnavailableError extends Error {
  constructor(readonly reason: "not_linked" | "no_agents" | "no_app_id") {
    super(
      reason === "not_linked"
        ? "Link your Slack account to Opengeni first."
        : reason === "no_agents"
          ? "Create a Slack agent first."
          : "Couldn't read the Slack app. Reconnect Opengeni in Slack.",
    );
    this.name = "SlackAgentUpdatePreviewUnavailableError";
  }
}

/**
 * Send one update message of `kind` to the caller's own linked Slack account
 * now. It ignores the schedule, the settings and mute, records nothing in the
 * per-person limits, and never messages anyone else. Uses the agents the caller
 * can use, or every agent of the installation when they can use none.
 */
export async function sendSlackAgentUpdatePreview(
  deps: ApiRouteDeps,
  input: {
    home: SweepHome;
    connectionId: string;
    slackTeamId: string;
    botUserId: string;
    subjectId: string;
    slackUserId: string;
    kind: SlackAgentUpdateKind;
  },
): Promise<{ agentIds: string[] }> {
  const agents = await listSlackAgentsForConnection(deps.db, input.home, {
    connectionId: input.connectionId,
  });
  if (agents.length === 0) throw new SlackAgentUpdatePreviewUnavailableError("no_agents");
  const reachable = new Set(
    (
      await listNamedSubjectSlackRoutableWorkspaces(deps.db, {
        accountId: input.home.accountId,
        subjectId: input.subjectId,
      })
    ).map((workspace) => workspace.workspaceId),
  );
  const usable = agents.filter((agent) => reachable.has(agent.targetWorkspaceId));
  const chosen = usable.length > 0 ? usable : agents;
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    ...input.home,
    connectionId: input.connectionId,
    subjectId: SLACK_AGENT_UPDATE_SUBJECT_ID,
  });
  const appId = await slackAppIdFor(client, input.connectionId, input.botUserId);
  if (!appId) throw new SlackAgentUpdatePreviewUnavailableError("no_app_id");
  const message = buildSlackAgentUpdateMessage({
    kind: input.kind,
    agents: chosen,
    botUserId: input.botUserId,
    homeUrl: slackAgentUpdateHomeUrl({ slackTeamId: input.slackTeamId, appId }),
    muteValue: "preview",
  });
  await client.postMessage({
    operationId: crypto.randomUUID(),
    userId: input.slackUserId,
    text: message.text,
    blocks: message.blocks,
  });
  return { agentIds: chosen.map((agent) => agent.id) };
}
