/**
 * Per-channel and per-DM Slack workspace routing.
 *
 * Routing is decided BEFORE any agent runs, from durable facts only, so it can
 * never be a model judgement. The resolver is pure with respect to the database
 * reads it is handed: it returns a decision, and the caller persists and acts on
 * it.
 *
 * Two rules are load-bearing and easy to break by accident:
 *
 *   A mapped thread keeps the workspace it was created in, unconditionally,
 *   including after the channel has been re-pointed. Otherwise a live
 *   conversation would silently change tenants mid-thread.
 *
 *   A subject who lacks access to the routed workspace is NEVER quietly served
 *   from another workspace they happen to belong to. Every failure is explicit
 *   and creates no session.
 */
import type { AccessGrant } from "@opengeni/contracts";
import type {
  SlackChannelRoute,
  SlackInteractionInboxEntry,
  SlackRoutableWorkspace,
  SlackUserDmRoute,
} from "@opengeni/db";

export type SlackRouteTenancy = { accountId: string; workspaceId: string };

export type SlackRouteResolution =
  | (SlackRouteTenancy & {
      kind: "resolved";
      label: string | null;
      source:
        | "thread"
        | "prefix"
        | "channel"
        | "dm_route"
        | "dm_personal"
        | "sole_candidate"
        | "installation";
    })
  | { kind: "ask"; candidates: readonly SlackRoutableWorkspace[] }
  | {
      kind: "denied";
      reason: "no_access_to_named" | "no_access_to_route" | "no_candidates";
      requested: string | null;
      candidates: readonly SlackRoutableWorkspace[];
    };

/**
 * A Slack direct message to the bot, by any trigger that can carry one.
 *
 * `isDirectMessageShortcut` is deliberately narrower: it means "a message
 * shortcut invoked inside a DM", which is a private-handoff concern. Routing
 * cares about the broader question of whether this conversation is one human's
 * private channel with the bot, which is also true of an ordinary `dm` event.
 */
export function isSlackDirectMessageConversation(
  entry: Pick<SlackInteractionInboxEntry, "triggerKind" | "slackChannelId">,
): boolean {
  return entry.triggerKind === "dm" || entry.slackChannelId.startsWith("D");
}

const PREFIX = "in ";

/**
 * Trigger kinds whose text the invoking human wrote themselves. A message
 * shortcut and a reaction both act on another person's message.
 */
const AUTHORED_BY_INVOKER: ReadonlySet<string> = new Set([
  "app_mention",
  "dm",
  "slash_command",
  "thread_reply",
]);

/**
 * Split a leading bot mention off the message text.
 *
 * Slack delivers an `app_mention` with the mention still in the text
 * (`<@U123> do the thing`), and OpenGeni stores it verbatim. The workspace
 * prefix is only an override when it is the first thing the person typed, so it
 * is parsed after the mention rather than at byte 0 of the raw text. Everything
 * split off here is put back, so the message the model sees is unchanged apart
 * from the addressing the person used to route it.
 */
export function splitSlackLeadingMention(
  text: string,
  botUserId: string | null,
): { lead: string; rest: string } {
  if (!botUserId || !/^[UWB][A-Z0-9]{1,63}$/u.test(botUserId)) return { lead: "", rest: text };
  const mention = `<@${botUserId}>`;
  if (!text.startsWith(mention)) return { lead: "", rest: text };
  const remainder = text.slice(mention.length);
  const trimmed = remainder.replace(/^[ \t]+/u, "");
  return { lead: text.slice(0, text.length - trimmed.length), rest: trimmed };
}

/**
 * The strict `in <workspace>: ...` override.
 *
 * Parsed only at byte 0, so ordinary prose that happens to contain the word
 * cannot trigger it, and matched case-insensitively against the exact label of a
 * workspace the subject can already start work in. A prefix that names nothing
 * recognizable is NOT a suggestion that falls through: it is a refusal, because
 * silently ignoring an explicit override is how a message lands somewhere the
 * person did not intend.
 */
export function parseSlackWorkspacePrefix(text: string): {
  requested: string;
  remainder: string;
} | null {
  if (!text.toLowerCase().startsWith(PREFIX)) return null;
  const separator = text.indexOf(":");
  if (separator <= PREFIX.length) return null;
  const requested = text.slice(PREFIX.length, separator).trim();
  if (requested.length === 0) return null;
  // A bare address with nothing after it is not a request.
  if (text.slice(separator + 1).trim().length === 0) return null;
  // A label is one line. A colon further down a multi-line message is not a
  // prefix, it is punctuation.
  if (/[\r\n]/u.test(requested)) return null;
  return { requested, remainder: text.slice(separator + 1).replace(/^[ \t]+/u, "") };
}

function matchCandidate(
  candidates: readonly SlackRoutableWorkspace[],
  requested: string,
): SlackRoutableWorkspace | null | "ambiguous" {
  const wanted = requested.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.label.toLowerCase() === wanted);
  // Two workspaces whose labels differ only by case are not a tie to break
  // silently: guessing one is the same failure as ignoring the override.
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

export type SlackRouteInputs = {
  /** The installation binding's tenancy. Always the fallback, never a silent one. */
  home: SlackRouteTenancy;
  entry: Pick<
    SlackInteractionInboxEntry,
    "triggerKind" | "slackChannelId" | "slackUserId" | "text"
  >;
  /**
   * The tenancy of an interaction already mapped to this thread, if any. A
   * mapped thread wins unconditionally.
   */
  threadTenancy: SlackRouteTenancy | null;
  channelRoute: SlackChannelRoute | null;
  dmRoute: SlackUserDmRoute | null;
  /** The subject's own personal workspace in the home organization, if any. */
  personalWorkspaceId: string | null;
  /** Workspaces this subject may actually start work in, ordered stably. */
  candidates: readonly SlackRoutableWorkspace[];
  /** The installation's bot user, so a mention does not hide the prefix. */
  botUserId: string | null;
  /** `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED`. */
  routingEnabled: boolean;
  /** Whether the first-use picker exists yet. Until it does, ambiguity keeps home. */
  askEnabled: boolean;
};

function labelFor(
  candidates: readonly SlackRoutableWorkspace[],
  workspaceId: string,
): string | null {
  return candidates.find((candidate) => candidate.workspaceId === workspaceId)?.label ?? null;
}

/**
 * Decide which workspace this Slack message starts work in.
 *
 * First match wins, and the order is deliberate: continuity beats an explicit
 * override beats configuration beats derivation beats asking.
 */
export function resolveSlackWorkspaceRoute(input: SlackRouteInputs): SlackRouteResolution {
  // A personal workspace is only ever a destination for that person's own bot
  // DM. Offering it in a channel would be wrong twice over: routing a shared
  // conversation into one member's private space hides it from everyone else
  // in the channel, and - because managed tenancy provisions a personal
  // workspace for every member - counting it as a candidate means nobody ever
  // has exactly one. That defeats the sole-candidate rule below, so an
  // organization with a single shared workspace would be asked to choose in
  // every channel despite having no choice to make.
  const directMessage = isSlackDirectMessageConversation(input.entry);
  const candidates = directMessage
    ? input.candidates
    : input.candidates.filter((candidate) => !candidate.personal);

  const installation = {
    kind: "resolved" as const,
    accountId: input.home.accountId,
    workspaceId: input.home.workspaceId,
    label: labelFor(candidates, input.home.workspaceId),
    source: "installation" as const,
  };

  // 0. With routing off no routing read is consulted, so an existing install is
  //    byte-identical. A thread that a previous flag-on window already mapped is
  //    still honoured, because its interaction, session and events genuinely
  //    live there: turning the flag off must stop new routing, not strand a
  //    conversation by addressing it in a workspace it is not in.
  if (!input.routingEnabled) {
    return input.threadTenancy
      ? {
          kind: "resolved",
          accountId: input.threadTenancy.accountId,
          workspaceId: input.threadTenancy.workspaceId,
          label: null,
          source: "thread",
        }
      : installation;
  }

  // 1. A mapped thread keeps its workspace, even if the channel moved since.
  if (input.threadTenancy) {
    return {
      kind: "resolved",
      accountId: input.threadTenancy.accountId,
      workspaceId: input.threadTenancy.workspaceId,
      label: labelFor(candidates, input.threadTenancy.workspaceId),
      source: "thread",
    };
  }

  // 2. The strict prefix override. It applies to this message only and never
  //    writes a route row: an override is not a decision about the channel.
  //
  //    Only text the invoking human actually typed can address anything. A
  //    message shortcut and a reaction both carry SOMEONE ELSE'S message, so a
  //    prefix found there was never an instruction to OpenGeni.
  const prefix = AUTHORED_BY_INVOKER.has(input.entry.triggerKind)
    ? parseSlackWorkspacePrefix(splitSlackLeadingMention(input.entry.text, input.botUserId).rest)
    : null;
  if (prefix) {
    const named = matchCandidate(candidates, prefix.requested);
    if (named === "ambiguous" || !named) {
      return {
        kind: "denied",
        reason: "no_access_to_named",
        requested: prefix.requested,
        candidates: candidates,
      };
    }
    return {
      kind: "resolved",
      accountId: named.accountId,
      workspaceId: named.workspaceId,
      label: named.label,
      source: "prefix",
    };
  }

  // 3. The channel's remembered answer.
  if (input.channelRoute) {
    return {
      kind: "resolved",
      accountId: input.channelRoute.targetAccountId,
      workspaceId: input.channelRoute.targetWorkspaceId,
      label: labelFor(candidates, input.channelRoute.targetWorkspaceId),
      source: "channel",
    };
  }

  // 4. A direct message is this human's own conversation with the bot, so it
  //    lands in their own workspace unless they chose otherwise. The personal
  //    workspace id is DERIVED from an active organization membership pointer;
  //    it is never accepted from a Slack payload or a route row.
  if (directMessage) {
    if (input.dmRoute) {
      return {
        kind: "resolved",
        accountId: input.dmRoute.targetAccountId,
        workspaceId: input.dmRoute.targetWorkspaceId,
        label: labelFor(candidates, input.dmRoute.targetWorkspaceId),
        source: "dm_route",
      };
    }
    if (input.personalWorkspaceId) {
      return {
        kind: "resolved",
        accountId: input.home.accountId,
        workspaceId: input.personalWorkspaceId,
        label: labelFor(candidates, input.personalWorkspaceId),
        source: "dm_personal",
      };
    }
    // No workspace of their own is not the same as no workspace at all. Fall
    // through to the ordinary rules so a member of exactly one shared workspace
    // can still work in their bot DM.
  }

  // 5. One workspace is not a choice. This is what keeps the flag quiet for
  //    installs that only ever had one workspace.
  const sole = candidates[0];
  if (candidates.length === 1 && sole) {
    return {
      kind: "resolved",
      accountId: sole.accountId,
      workspaceId: sole.workspaceId,
      label: sole.label,
      source: "sole_candidate",
    };
  }

  if (candidates.length === 0) {
    return { kind: "denied", reason: "no_candidates", requested: null, candidates: [] };
  }

  // 6. Genuinely ambiguous. Until the picker exists, keep the installation's
  //    workspace rather than inventing an answer.
  return input.askEnabled ? { kind: "ask", candidates: candidates } : installation;
}

/**
 * The message text the model actually sees.
 *
 * A prefix override is addressing information, not part of the request, so it is
 * stripped exactly once and only when it matched.
 */
export function slackRoutedRequestText(
  text: string,
  resolution: SlackRouteResolution,
  botUserId: string | null,
): string {
  if (resolution.kind !== "resolved" || resolution.source !== "prefix") return text;
  const { lead, rest } = splitSlackLeadingMention(text, botUserId);
  // Reached only for a `prefix` resolution, which the authorship rule above
  // already restricted to text the invoking human wrote.
  const parsed = parseSlackWorkspacePrefix(rest);
  return parsed ? `${lead}${parsed.remainder}` : text;
}

export type SlackRouteAuthorization =
  | { kind: "authorized"; grant: AccessGrant; tenancy: SlackRouteTenancy; label: string | null }
  | { kind: "denied"; reason: "no_access_to_route"; tenancy: SlackRouteTenancy };
