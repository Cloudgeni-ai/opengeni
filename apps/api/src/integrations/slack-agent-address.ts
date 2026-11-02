import { slackAgentNameKey } from "@opengeni/contracts";

/** What routing needs to know about one Slack agent. Ids and names only. */
export type SlackRoutingAgent = {
  id: string;
  name: string;
  nameKey: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  /** The target workspace's name, for refusals. */
  targetWorkspaceLabel: string | null;
  /** Anyone in Slack can use it, not only members of its workspace. */
  open?: boolean;
};

export type SlackAgentAddress =
  | {
      kind: "agent";
      agent: SlackRoutingAgent;
      /** `plus` for `+name`, `name` for a bare name at the start. */
      via: "plus" | "name";
      /** The text after the name, or null when nothing followed it. */
      remainder: string | null;
    }
  | { kind: "unknown"; requested: string };

/** A name ends at whitespace, the end, or punctuation people put after a name. */
const NAME_END = /[\s,:;.!?)]/u;
/** Longest name a person can type, in characters, with some slack for spacing. */
const MAX_ADDRESS_CHARS = 120;

function nameBoundaries(body: string): number[] {
  const ends: number[] = [];
  const limit = Math.min(body.length, MAX_ADDRESS_CHARS);
  for (let index = 1; index <= limit; index += 1) {
    if (index === body.length || NAME_END.test(body[index]!)) {
      // Skip a boundary inside a run of separators: "Analytics,  x" has one.
      if (!NAME_END.test(body[index - 1]!)) ends.push(index);
    }
  }
  return ends;
}

/** True when `left` and `right` differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function remainderAfter(body: string, end: number): string | null {
  const rest = body.slice(end).replace(/^[\s,:;.!?)]+/u, "");
  return rest.trim().length > 0 ? rest : null;
}

/**
 * Find the Slack agent a message addresses at its start: the longest agent
 * name, or `+name`. Case, spaces and hyphens are ignored, so multi-word names
 * work however they are typed.
 *
 * `+name` also tolerates one typo when exactly one agent is that close. An
 * unmatched `+name` is reported as unknown, because a person who typed `+` meant
 * an agent. An unmatched bare word is ordinary text and returns null.
 *
 * With no agents this always returns null, so an installation without agents
 * reads every message exactly as before.
 */
export function matchSlackAgentAddress(
  text: string,
  agents: readonly SlackRoutingAgent[],
  options: { allowBare: boolean; allowPlus: boolean },
): SlackAgentAddress | null {
  if (agents.length === 0) return null;
  const plus = text.startsWith("+");
  if (plus ? !options.allowPlus : !options.allowBare) return null;
  const body = plus ? text.slice(1) : text;
  // "+1", "+100" and "+ also this" are Slack idioms, not calls: `+` addresses
  // an agent only when a letter follows, and a name starting with a digit is
  // then matched exactly.
  if (body.length === 0 || /^\s/u.test(body)) return null;
  const letterLed = /^\p{L}/u.test(body);
  const byKey = new Map(agents.map((agent) => [agent.nameKey, agent]));
  const ends = nameBoundaries(body);
  for (let index = ends.length - 1; index >= 0; index -= 1) {
    const end = ends[index]!;
    const agent = byKey.get(slackAgentNameKey(body.slice(0, end)));
    if (agent) {
      return {
        kind: "agent",
        agent,
        via: plus ? "plus" : "name",
        remainder: remainderAfter(body, end),
      };
    }
  }
  if (!plus || !letterLed) return null;
  // One typo, only for `+name`, and only when one agent is that close. Of the
  // ends within one edit, keep the one closest to the name's length, so
  // "+analytic is down" keeps "is" in the request.
  const close = new Map<string, { agent: SlackRoutingAgent; end: number; distance: number }>();
  for (const end of ends) {
    const key = slackAgentNameKey(body.slice(0, end));
    if (key.length < 3) continue;
    for (const agent of agents) {
      if (agent.nameKey.length >= 3 && withinOneEdit(key, agent.nameKey)) {
        const distance = Math.abs(key.length - agent.nameKey.length);
        const seen = close.get(agent.id);
        if (!seen || distance < seen.distance) close.set(agent.id, { agent, end, distance });
      }
    }
  }
  if (close.size === 1) {
    const [only] = close.values();
    return {
      kind: "agent",
      agent: only!.agent,
      via: "plus",
      remainder: remainderAfter(body, only!.end),
    };
  }
  const requested = body.split(/[\s,:;.!?)]/u)[0] ?? "";
  return { kind: "unknown", requested: [...requested].slice(0, 80).join("") };
}
