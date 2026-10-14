import { isSessionId } from "../timeline/agent-identity";
import { namedAgentTitle, type AgentTitleParts } from "../timeline/platform-activity-presentation";
import type { MachineInputMember } from "../timeline/types";

export const MACHINE_INPUT_META: Record<MachineInputMember["kind"], string> = {
  scheduled_occurrence: "Scheduled update",
  goal_continuation: "Goal continued",
  background_command_result: "Command result received",
  session_wait_timeout: "Wait ended",
  agent_message: "Agent update",
  agent_steer_instruction: "Agent direction",
  child_terminal_result: "Agent result received",
  media_generation_result: "Video update",
  child_requires_action: "Agent needs input",
  child_requires_action_resolved: "Agent unblocked",
  child_paused: "Agent paused",
  child_waiting_capacity: "Agent waiting for capacity",
  child_progress: "Agent progress",
};

/**
 * Collapsed landmark label for a coalesced machine-input batch.
 * Same-kind batches get a natural plural; mixed kinds stay short.
 * When every agent update's sender has a known title, the label names them
 * ("Update from Release audit", "3 updates from Audit and Flake · Wait ended").
 */
export function machineInputBatchLabel(
  members: readonly MachineInputMember[],
  titleFor?: ((sessionId: string) => string | null) | undefined,
): string {
  if (members.length === 0) return "Updates";
  const named = titleFor ? namedAgentBatchLabel(members, titleFor) : null;
  if (named) return named;
  const counts = new Map<MachineInputMember["kind"], number>();
  for (const member of members) {
    counts.set(member.kind, (counts.get(member.kind) ?? 0) + 1);
  }
  if (counts.size === 1) {
    const kind = members[0]!.kind;
    const n = members.length;
    switch (kind) {
      case "background_command_result":
        return n === 1 ? "Command result received" : `${n} command results received`;
      case "session_wait_timeout":
        return n === 1 ? "Wait ended" : `${n} waits ended`;
      case "child_terminal_result":
        return n === 1 ? "Agent result received" : `${n} agent results received`;
      case "goal_continuation":
        return n === 1 ? "Goal continued" : `${n} goal continuations`;
      case "scheduled_occurrence":
        return n === 1 ? "Scheduled update" : `${n} scheduled updates`;
      case "agent_message":
        return n === 1 ? "Agent update" : `${n} agent updates`;
      case "agent_steer_instruction":
        return n === 1 ? "Agent direction" : `${n} agent directions`;
      case "media_generation_result":
        return n === 1 ? "Video ready" : `${n} video updates`;
      case "child_requires_action":
        return n === 1 ? "Agent needs input" : `${n} agents need input`;
      case "child_requires_action_resolved":
        return n === 1 ? "Agent unblocked" : `${n} agents unblocked`;
      case "child_paused":
        return n === 1 ? "Agent paused" : `${n} agents paused`;
      case "child_waiting_capacity":
        return n === 1 ? "Agent waiting for capacity" : `${n} agents waiting for capacity`;
      case "child_progress":
        return n === 1 ? "Agent progress" : `${n} agent progress notes`;
    }
  }
  const parts = [...counts.entries()].map(([kind, count]) => {
    const label = MACHINE_INPUT_META[kind];
    return count === 1 ? label : `${count}× ${label}`;
  });
  const preview = parts.slice(0, 2).join(", ");
  const suffix = parts.length > 2 ? ", …" : "";
  return `${members.length} updates · ${preview}${suffix}`;
}

function namedAgentBatchLabel(
  members: readonly MachineInputMember[],
  titleFor: (sessionId: string) => string | null,
): string | null {
  const agents = members.filter(isAgentMember);
  if (agents.length === 0) return null;
  const names: string[] = [];
  for (const member of agents) {
    const sessionId = agentMemberSessionId(member);
    const name = sessionId ? titleFor(sessionId) : null;
    if (!name) return null;
    if (!names.includes(name)) names.push(name);
  }
  const others = members.filter((member) => !isAgentMember(member));
  const agentPart =
    agents.length === 1
      ? agentMemberTitle(agents[0]!, names[0]!).text
      : `${agents.length} updates from ${
          names.length === 1
            ? names[0]
            : names.length === 2
              ? `${names[0]} and ${names[1]}`
              : `${names.length} agents`
        }`;
  if (others.length === 0) return agentPart;
  const counts = new Map<MachineInputMember["kind"], number>();
  for (const member of others) counts.set(member.kind, (counts.get(member.kind) ?? 0) + 1);
  const rest = [...counts.entries()]
    .map(([kind, count]) =>
      count === 1 ? MACHINE_INPUT_META[kind] : `${count}× ${MACHINE_INPUT_META[kind]}`,
    )
    .join(", ");
  return `${agentPart} · ${rest}`;
}

/** Strip protocol prefixes and worker/session UUIDs from display summaries. */
export function cleanMachineInputSummary(summary: string): string {
  return summary
    .replace(/^\[[A-Z][A-Z _-]*(?:\s+\d+\/\d+)?\]\s*/, "")
    .replace(/\bWorker session id:\s*[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s*[·|]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

export function readableMachineInputSource(sourceId: string): string | null {
  const value = sourceId.trim();
  if (!value || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return null;
  if (/^(goal|schedule|system):/i.test(value)) return null;
  return value.replaceAll("_", " ");
}

/** True when a cleaned single-member summary adds meaning beyond the pill label. */
export function machineInputSummaryIsUseful(
  kind: MachineInputMember["kind"],
  cleanedSummary: string,
): boolean {
  if (!cleanedSummary) return false;
  const label = MACHINE_INPUT_META[kind].toLowerCase();
  const text = cleanedSummary.toLowerCase();
  if (text === label || text === `${label}.`) return false;
  // Generic child-finished boilerplate after UUID scrub is still noise.
  if (
    kind === "child_terminal_result" &&
    /^a worker session you spawned has finished/i.test(cleanedSummary)
  ) {
    return false;
  }
  return true;
}

/* --- agent members ----------------------------------------------------------- */

const AGENT_MEMBER_KINDS: ReadonlySet<MachineInputMember["kind"]> = new Set([
  "agent_message",
  "agent_steer_instruction",
  "child_terminal_result",
  "child_requires_action",
  "child_requires_action_resolved",
  "child_paused",
  "child_waiting_capacity",
  "child_progress",
]);

/** Members sent by (or about) another agent session. */
export function isAgentMember(member: Pick<MachineInputMember, "kind">): boolean {
  return AGENT_MEMBER_KINDS.has(member.kind);
}

/** The agent session a member came from; only typed UUID sources route. */
export function agentMemberSessionId(
  member: Pick<MachineInputMember, "kind" | "sourceId">,
): string | null {
  return isAgentMember(member) && isSessionId(member.sourceId) ? member.sourceId : null;
}

/**
 * The row title for an agent member. A child result only means the agent went
 * idle, so it reads "Result from …", never "finished".
 */
export function agentMemberTitle(
  member: Pick<MachineInputMember, "kind" | "classification">,
  name: string | null,
): AgentTitleParts {
  const fallback = MACHINE_INPUT_META[member.kind];
  switch (member.kind) {
    case "agent_message":
      return namedAgentTitle(name, "Update from ", "", fallback);
    case "agent_steer_instruction":
      return namedAgentTitle(name, "Direction from ", "", fallback);
    case "child_terminal_result":
      return member.classification === "failure"
        ? namedAgentTitle(name, "", " failed", "Agent failed")
        : namedAgentTitle(name, "Result from ", "", fallback);
    case "child_requires_action":
      return namedAgentTitle(name, "", " needs input", fallback);
    case "child_requires_action_resolved":
      return namedAgentTitle(name, "", " unblocked", fallback);
    case "child_paused":
      return namedAgentTitle(name, "", " paused", fallback);
    case "child_waiting_capacity":
      return namedAgentTitle(name, "", " is waiting for capacity", fallback);
    case "child_progress":
      return namedAgentTitle(name, "Progress from ", "", fallback);
    default:
      return namedAgentTitle(null, "", "", fallback);
  }
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * Drop the protocol tag and "Worker session id: …" routing note from a
 * server-written child notice, keeping every other character (and line break)
 * of the agent's own words.
 */
function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\[[A-Z][A-Z _-]*(?:\s+\d+\/\d+)?\]\s*/, "")
        .replace(/\s*\bWorker session id:\s*[0-9a-f]{8}-[0-9a-f-]{27,}\b\.?/gi, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Human text for an agent member: the agent's own words where the summary
 * carries them, without the model-facing "Worker <id> …" framing. `preview`
 * is the most useful single passage; `body` is everything worth reading.
 */
export function agentMemberText(member: Pick<MachineInputMember, "kind" | "summary">): {
  preview: string;
  body: string;
} {
  const raw = member.summary.trim();
  const same = (text: string) => ({ preview: text.replace(/\s+/g, " "), body: text });
  switch (member.kind) {
    case "child_progress":
      return same(cleanLines(raw.replace(/^Worker \S+ progress:\s*/, "")));
    case "child_requires_action":
      return same(
        cleanLines(
          raw
            .replace(/^Worker \S+ is blocked and needs input(?: \(turn [^)]*\))?\.\s*/, "")
            .replace(/^It asked:\s*/, "")
            .replace(/([?!])\.$/, "$1"),
        ),
      );
    case "child_requires_action_resolved":
      return same(capitalize(cleanLines(raw.replace(/^Worker \S+:\s*/, ""))));
    case "child_paused": {
      const match = /^Worker \S+ was paused by (.+?)\.(?:\s*Reason:\s*([\s\S]*))?$/.exec(raw);
      if (!match) return same(cleanLines(raw));
      return same(match[2]?.trim() ? cleanLines(match[2]) : `Paused by ${match[1]}`);
    }
    case "child_waiting_capacity":
      return same(capitalize(cleanLines(raw.replace(/^Worker \S+ is\s+/, ""))));
    case "child_terminal_result": {
      const lines = raw.split("\n").map((line) => line.trim());
      const rest = lines.filter(
        (line) => line.length > 0 && !/^A worker session you spawned has\b/i.test(line),
      );
      const field = (prefix: string) =>
        rest
          .find((line) => line.startsWith(prefix))
          ?.slice(prefix.length)
          .trim() || null;
      const goal = field("Worker goal:");
      const evidence = field("Completion evidence:");
      const rationale = field("Pause rationale:");
      const body = cleanLines(
        rest
          .map((line) =>
            line
              .replace(/^Worker goal:\s*/, "Goal: ")
              .replace(/^Completion evidence:\s*/, "Evidence: ")
              .replace(/^Pause rationale:\s*/, "Paused because: "),
          )
          .join("\n"),
      );
      const preview = cleanLines(evidence ?? rationale ?? goal ?? body);
      return { preview: preview.replace(/\s+/g, " "), body };
    }
    default:
      // Agent messages and directions are the sender's own words, verbatim.
      return same(raw);
  }
}
