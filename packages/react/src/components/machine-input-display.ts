import type { MachineInputMember } from "../timeline/types";

export const MACHINE_INPUT_META: Record<MachineInputMember["kind"], string> = {
  scheduled_occurrence: "Scheduled update",
  goal_continuation: "Goal continued",
  agent_message: "Agent update",
  agent_steer_instruction: "Agent direction",
  child_terminal_result: "Agent finished",
};

/**
 * Collapsed landmark label for a coalesced machine-input batch.
 * Same-kind batches get a natural plural; mixed kinds stay short.
 */
export function machineInputBatchLabel(members: readonly MachineInputMember[]): string {
  if (members.length === 0) return "Updates";
  const counts = new Map<MachineInputMember["kind"], number>();
  for (const member of members) {
    counts.set(member.kind, (counts.get(member.kind) ?? 0) + 1);
  }
  if (counts.size === 1) {
    const kind = members[0]!.kind;
    const n = members.length;
    switch (kind) {
      case "child_terminal_result":
        return n === 1 ? "Agent finished" : `${n} agents finished`;
      case "goal_continuation":
        return n === 1 ? "Goal continued" : `${n} goal continuations`;
      case "scheduled_occurrence":
        return n === 1 ? "Scheduled update" : `${n} scheduled updates`;
      case "agent_message":
        return n === 1 ? "Agent update" : `${n} agent updates`;
      case "agent_steer_instruction":
        return n === 1 ? "Agent direction" : `${n} agent directions`;
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
