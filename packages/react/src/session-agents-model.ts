import type { LineageNode, SessionGoal } from "@opengeni/sdk";

/* Renderer-neutral session chrome signals shared by the web dock and native
   apps: the sub-agents chip and the goal chip. */

export type SessionAgentsSignal = {
  count: number;
  detail: string;
  tone: "running" | "waiting" | "neutral";
};

/** The agents chip for a session's spawned workers, or undefined without any. */
export function sessionAgentsSignal(
  agents: readonly Pick<LineageNode, "session">[],
): SessionAgentsSignal | undefined {
  if (agents.length === 0) return undefined;
  const running = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const paused = agents.filter((node) => node.session.effectiveControl.state === "paused").length;
  return {
    count: agents.length,
    detail: running > 0 ? `${running} running` : paused > 0 ? `${paused} paused` : "Idle",
    tone: running > 0 ? "running" : paused > 0 ? "waiting" : "neutral",
  };
}

/** One human word for a goal's state, as the web goal pill reads. */
export function sessionGoalStateLabel(goal: Pick<SessionGoal, "status">): string {
  if (goal.status === "completed") return "Completed";
  if (goal.status === "paused") return "Paused";
  return "Active";
}
