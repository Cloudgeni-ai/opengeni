// The words and grouping of the conversation's landmarks: goal pills, worker
// reports and other agents' updates. Shared by the web timeline and the React
// Native timeline so both say the same thing. No DOM, styles or icons.
import type { OpenGeniText } from "../messages/runtime";
import { isAgentMember } from "../components/machine-input-display";
import { namedAgentTitle, type AgentTitleParts } from "./platform-activity-presentation";
import type { GoalItem, MachineInputMember, WorkerCompletionItem } from "./types";

/** How a goal landmark reads: done, held (asks to resume), opening one, or neutral. */
export type GoalLandmarkTone = "accent" | "success" | "waiting" | "neutral";

export function goalLandmarkLabel(t: OpenGeniText, action: GoalItem["action"]): string {
  switch (action) {
    case "set":
      return t("messageTimeline.goalSet");
    case "updated":
      return t("messageTimeline.goalUpdated");
    case "completed":
      return t("messageTimeline.goalCompleted");
    case "paused":
      return t("messageTimeline.goalPaused");
    case "resumed":
      return t("messageTimeline.goalResumed");
    case "cleared":
      return t("messageTimeline.goalCleared");
    case "held":
      return t("messageTimeline.goalHeld");
    case "continuation":
      return t("messageTimeline.continuingTowardTheGoal");
  }
}

/** Color only where it is earned: done is success, a held goal waits. */
export function goalLandmarkTone(action: GoalItem["action"]): GoalLandmarkTone {
  return action === "set"
    ? "accent"
    : action === "completed"
      ? "success"
      : action === "paused" || action === "held"
        ? "waiting"
        : "neutral";
}

/** The pill's text: the label, then the goal shortened to one line. */
export function goalLandmarkText(t: OpenGeniText, item: Pick<GoalItem, "action" | "text">) {
  const label = goalLandmarkLabel(t, item.action);
  return item.text ? `${label}: ${shorten(item.text, 90)}` : label;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export type WorkerCompletionOutcome = "failed" | "paused" | "completed" | "reported";

/** A worker reporting back: its outcome, named when the agent's title is known. */
export function workerCompletionPresentation(
  t: OpenGeniText,
  item: Pick<WorkerCompletionItem, "childStatus" | "goalStatus">,
  name: string | null,
): { title: AgentTitleParts; outcome: WorkerCompletionOutcome } {
  if (item.childStatus === "failed")
    return {
      title: namedAgentTitle(
        name,
        (agent) => t("messageTimeline.nameFailed", { name: agent }),
        t("messageTimeline.workerFailed"),
      ),
      outcome: "failed",
    };
  if (item.goalStatus === "paused")
    return {
      title: namedAgentTitle(
        name,
        (agent) => t("messageTimeline.namePaused", { name: agent }),
        t("messageTimeline.workerPaused"),
      ),
      outcome: "paused",
    };
  if (item.goalStatus === "completed")
    return {
      title: namedAgentTitle(
        name,
        (agent) => t("messageTimeline.nameCompletedItsGoal", { name: agent }),
        t("messageTimeline.workerCompleted"),
      ),
      outcome: "completed",
    };
  return {
    title: namedAgentTitle(
      name,
      (agent) => t("messageTimeline.resultFromName", { name: agent }),
      t("messageTimeline.workerReportedBack"),
    ),
    outcome: "reported",
  };
}

/** The labelled sections behind a worker report's disclosure. */
export function workerCompletionSections(
  t: OpenGeniText,
  item: Pick<
    WorkerCompletionItem,
    "text" | "evidence" | "pausedReason" | "childStatus" | "goalStatus"
  >,
): { label: string; value: string; muted?: true }[] {
  // "Paused because" only when the outcome actually IS a pause: completion
  // payloads can carry a leftover pausedReason from earlier in the worker's life.
  const showPausedReason =
    item.childStatus !== "failed" && item.goalStatus === "paused" && !!item.pausedReason?.trim();
  return [
    ...(item.text.trim() ? [{ label: t("messageTimeline.report"), value: item.text.trim() }] : []),
    ...(item.evidence?.trim()
      ? [
          {
            label: t("messageTimeline.evidence"),
            value: item.evidence.trim(),
            muted: true as const,
          },
        ]
      : []),
    ...(showPausedReason
      ? [
          {
            label: t("messageTimeline.pausedBecause"),
            value: item.pausedReason!.trim(),
            muted: true as const,
          },
        ]
      : []),
  ];
}

export type MachineInputMemberGroup =
  | { kind: "agent"; members: MachineInputMember[] }
  | { kind: "other"; member: MachineInputMember };

/**
 * Agent members get named rows; repeated progress notes from one agent fold
 * into its single row (latest note shown, earlier ones behind the disclosure).
 */
export function groupMachineInputMembers(
  members: readonly MachineInputMember[],
): MachineInputMemberGroup[] {
  const groups: MachineInputMemberGroup[] = [];
  const progressBySource = new Map<string, MachineInputMember[]>();
  for (const member of members) {
    if (!isAgentMember(member)) {
      groups.push({ kind: "other", member });
      continue;
    }
    if (member.kind === "child_progress") {
      const existing = progressBySource.get(member.sourceId);
      if (existing) {
        existing.push(member);
        continue;
      }
      const bucket = [member];
      progressBySource.set(member.sourceId, bucket);
      groups.push({ kind: "agent", members: bucket });
      continue;
    }
    groups.push({ kind: "agent", members: [member] });
  }
  return groups;
}
