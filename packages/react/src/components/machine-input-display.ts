import { isSessionId } from "../timeline/agent-identity";
import { namedAgentTitle, type AgentTitleParts } from "../timeline/platform-activity-presentation";
import type { MachineInputMember } from "../timeline/types";
import { type OpenGeniText } from "../messages/runtime";

export const MACHINE_INPUT_META = (
  t: OpenGeniText,
): Record<MachineInputMember["kind"], string> => ({
  scheduled_occurrence: t("machineInputDisplay.automationRun"),
  goal_continuation: t("machineInputDisplay.goalContinued"),
  background_command_result: t("machineInputDisplay.commandResultReceived"),
  session_wait_timeout: t("machineInputDisplay.waitEnded"),
  agent_message: t("machineInputDisplay.agentUpdate"),
  agent_steer_instruction: t("machineInputDisplay.agentDirection"),
  child_terminal_result: t("machineInputDisplay.agentResultReceived"),
  media_generation_result: t("machineInputDisplay.videoUpdate"),
  secret_use_approval_decided: t("machineInputDisplay.secretUseAnswered"),
  child_requires_action: t("machineInputDisplay.agentNeedsInput"),
  child_requires_action_resolved: t("machineInputDisplay.agentUnblocked"),
  child_paused: t("machineInputDisplay.agentPaused"),
  child_waiting_capacity: t("machineInputDisplay.agentWaitingForCapacity"),
  child_progress: t("machineInputDisplay.agentProgress"),
  capability_setup_completed: t("machineInputDisplay.setupFinished"),
});

/**
 * Collapsed landmark label for a coalesced machine-input batch.
 * Same-kind batches get a natural plural; mixed kinds stay short.
 * When every agent update's sender has a known title, the label names them
 * ("Update from Release audit", "3 updates from Audit and Flake · Wait ended").
 */
export function machineInputBatchLabel(
  t: OpenGeniText,
  members: readonly MachineInputMember[],
  titleFor?: ((sessionId: string) => string | null) | undefined,
): string {
  if (members.length === 0) return t("machineInputDisplay.updates");
  const named = titleFor ? namedAgentBatchLabel(t, members, titleFor) : null;
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
        return n === 1
          ? t("machineInputDisplay.commandResultReceived")
          : t("machineInputDisplay.commandResultsReceivedCount", { count: n });
      case "session_wait_timeout":
        return n === 1
          ? t("machineInputDisplay.waitEnded")
          : t("machineInputDisplay.waitsEndedCount", { count: n });
      case "child_terminal_result":
        return n === 1
          ? t("machineInputDisplay.agentResultReceived")
          : t("machineInputDisplay.agentResultsReceivedCount", { count: n });
      case "goal_continuation":
        return n === 1
          ? t("machineInputDisplay.goalContinued")
          : t("machineInputDisplay.goalContinuationsCount", { count: n });
      case "scheduled_occurrence":
        return n === 1
          ? t("machineInputDisplay.automationRun")
          : t("machineInputDisplay.automationRunsCount", { count: n });
      case "agent_message":
        return n === 1
          ? t("machineInputDisplay.agentUpdate")
          : t("machineInputDisplay.agentUpdatesCount", { count: n });
      case "agent_steer_instruction":
        return n === 1
          ? t("machineInputDisplay.agentDirection")
          : t("machineInputDisplay.agentDirectionsCount", { count: n });
      case "media_generation_result":
        return n === 1
          ? t("machineInputDisplay.videoReady")
          : t("machineInputDisplay.videoUpdatesCount", { count: n });
      case "secret_use_approval_decided":
        return n === 1
          ? t("machineInputDisplay.secretUseAnswered")
          : t("machineInputDisplay.secretUsesAnsweredCount", { count: n });
      case "child_requires_action":
        return n === 1
          ? t("machineInputDisplay.agentNeedsInput")
          : t("machineInputDisplay.agentsNeedInputCount", { count: n });
      case "child_requires_action_resolved":
        return n === 1
          ? t("machineInputDisplay.agentUnblocked")
          : t("machineInputDisplay.agentsUnblockedCount", { count: n });
      case "child_paused":
        return n === 1
          ? t("machineInputDisplay.agentPaused")
          : t("machineInputDisplay.agentsPausedCount", { count: n });
      case "child_waiting_capacity":
        return n === 1
          ? t("machineInputDisplay.agentWaitingForCapacity")
          : t("machineInputDisplay.agentsWaitingForCapacityCount", { count: n });
      case "child_progress":
        return n === 1
          ? t("machineInputDisplay.agentProgress")
          : t("machineInputDisplay.agentProgressNotesCount", { count: n });
      case "capability_setup_completed":
        return n === 1
          ? t("machineInputDisplay.setupFinished")
          : t("machineInputDisplay.setupsFinishedCount", { count: n });
    }
  }
  const parts = [...counts.entries()].map(([kind, count]) => {
    const label = MACHINE_INPUT_META(t)[kind];
    return count === 1 ? label : t("machineInputDisplay.countTimesLabel", { count, label });
  });
  const preview = parts.slice(0, 2).join(", ");
  const suffix = parts.length > 2 ? ", …" : "";
  return t("machineInputDisplay.lengthUpdatesPreviewSuffix", {
    length: members.length,
    preview,
    suffix,
  });
}

function namedAgentBatchLabel(
  t: OpenGeniText,
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
      ? agentMemberTitle(t, agents[0]!, names[0]!).text
      : names.length === 1
        ? t("machineInputDisplay.updatesFromName", { count: agents.length, name: names[0]! })
        : names.length === 2
          ? t("machineInputDisplay.updatesFromTwoNames", {
              count: agents.length,
              first: names[0]!,
              second: names[1]!,
            })
          : t("machineInputDisplay.updatesFromAgents", {
              count: agents.length,
              agents: names.length,
            });
  if (others.length === 0) return agentPart;
  const counts = new Map<MachineInputMember["kind"], number>();
  for (const member of others) counts.set(member.kind, (counts.get(member.kind) ?? 0) + 1);
  const rest = [...counts.entries()]
    .map(([kind, count]) =>
      count === 1
        ? MACHINE_INPUT_META(t)[kind]
        : t("machineInputDisplay.countTimesLabel", { count, label: MACHINE_INPUT_META(t)[kind] }),
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
  t: OpenGeniText,
  kind: MachineInputMember["kind"],
  cleanedSummary: string,
): boolean {
  if (!cleanedSummary) return false;
  const label = MACHINE_INPUT_META(t)[kind].toLowerCase();
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
  t: OpenGeniText,
  member: Pick<MachineInputMember, "kind" | "classification">,
  name: string | null,
): AgentTitleParts {
  const fallback = MACHINE_INPUT_META(t)[member.kind];
  switch (member.kind) {
    case "agent_message":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.updateFromName", { name: agent }),
        fallback,
      );
    case "agent_steer_instruction":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.directionFromName", { name: agent }),
        fallback,
      );
    case "child_terminal_result":
      return member.classification === "failure"
        ? namedAgentTitle(
            name,
            (agent) => t("machineInputDisplay.nameFailed", { name: agent }),
            t("machineInputDisplay.agentFailed"),
          )
        : namedAgentTitle(
            name,
            (agent) => t("machineInputDisplay.resultFromName", { name: agent }),
            fallback,
          );
    case "child_requires_action":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.nameNeedsInput", { name: agent }),
        fallback,
      );
    case "child_requires_action_resolved":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.nameUnblocked", { name: agent }),
        fallback,
      );
    case "child_paused":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.namePaused", { name: agent }),
        fallback,
      );
    case "child_waiting_capacity":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.nameIsWaitingForCapacity", { name: agent }),
        fallback,
      );
    case "child_progress":
      return namedAgentTitle(
        name,
        (agent) => t("machineInputDisplay.progressFromName", { name: agent }),
        fallback,
      );
    default:
      return namedAgentTitle(null, () => fallback, fallback);
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
export function agentMemberText(
  t: OpenGeniText,
  member: Pick<MachineInputMember, "kind" | "summary">,
): {
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
      return same(
        match[2]?.trim()
          ? cleanLines(match[2])
          : t("machineInputDisplay.pausedByValue", { value: match[1] }),
      );
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
              .replace(/^Worker goal:\s*/, `${t("machineInputDisplay.goalLabel")} `)
              .replace(/^Completion evidence:\s*/, `${t("machineInputDisplay.evidenceLabel")} `)
              .replace(/^Pause rationale:\s*/, `${t("machineInputDisplay.pausedBecauseLabel")} `),
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
