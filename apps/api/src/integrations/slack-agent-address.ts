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
      /**
       * The punctuation right after the name, such as "," in "Data, take
       * this", or null when a space, another word or nothing follows it.
       */
      end: string | null;
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

/** Letters and digits only, compared like name keys. */
function wordKey(value: string): string {
  return slackAgentNameKey(value).replace(/[^\p{L}\p{N}]/gu, "");
}

/** Last words of a name people often leave out ("the analytics folks" for "Analytics team"). */
const GENERIC_NAME_ENDINGS = new Set([
  "team",
  "desk",
  "agent",
  "helper",
  "assistant",
  "group",
  "squad",
  "crew",
]);

/** Shortest name, in letters, that tolerates a typo; shorter names collide with ordinary words ("date", "data"). */
const MIN_TYPO_TOLERANT_LETTERS = 5;

/**
 * Whether a message asks for an agent by name anywhere in it: its words, in
 * order, spell the agent's name ("ask the data team", "+data-team"), allowing
 * one typo for names of five or more letters. A name ending in a generic word
 * like "team" also matches without it when the rest is five or more letters
 * ("analytics" for "Analytics team", but not "data" for "Data team"). Slack
 * mentions and links are ignored. This is the server's check before a chat may
 * hand a message off; the chat's instructions decide the rest.
 */
export function slackTextNamesAgent(text: string, agent: Pick<SlackRoutingAgent, "name">): boolean {
  const nameParts = agent.name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(wordKey);
  const full = nameParts.join("");
  if (full.length === 0) return false;
  const targets = [full];
  const core = nameParts.slice(0, -1).join("");
  if (
    nameParts.length >= 2 &&
    GENERIC_NAME_ENDINGS.has(nameParts[nameParts.length - 1]!) &&
    core.length >= MIN_TYPO_TOLERANT_LETTERS
  ) {
    targets.push(core);
  }
  const words = (text.replace(/<[^>]*>/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []).map(wordKey);
  const longest = Math.max(1, nameParts.length + 1);
  for (const target of targets) {
    for (let start = 0; start < words.length; start += 1) {
      let joined = "";
      for (let size = 1; size <= longest && start + size <= words.length; size += 1) {
        joined += words[start + size - 1];
        if (joined === target) return true;
        if (target.length >= MIN_TYPO_TOLERANT_LETTERS && withinOneEdit(joined, target)) {
          return true;
        }
        if (joined.length > target.length + 1) break;
      }
    }
  }
  return false;
}

/** The punctuation people put right after a name ("Data, …", "Data: …"), or null. */
function punctuationAfter(body: string, end: number): string | null {
  const next = body.slice(end).replace(/^[ \t]+/u, "")[0];
  return next !== undefined && /[,:;.!?)]/u.test(next) ? next : null;
}

/**
 * Whether a match is clearly an address, not the start of a sentence: `+name`,
 * the name alone, or the name followed by "," or ":". Inside a thread that
 * already has a chat only these move the thread to another agent, so "@Opengeni
 * data looks fine now" stays with the chat it was meant for.
 */
export function slackAgentAddressIsExplicit(
  address: Extract<SlackAgentAddress, { kind: "agent" }>,
): boolean {
  return (
    address.via === "plus" ||
    address.remainder === null ||
    address.end === "," ||
    address.end === ":"
  );
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
        end: punctuationAfter(body, end),
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
      end: punctuationAfter(body, only!.end),
    };
  }
  const requested = body.split(/[\s,:;.!?)]/u)[0] ?? "";
  return { kind: "unknown", requested: [...requested].slice(0, 80).join("") };
}
