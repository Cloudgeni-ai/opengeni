import type { LineageNode, SessionGoal, SessionSummary } from "@opengeni/sdk";
import { type OpenGeniText } from "./messages/runtime";
import { sessionAdmissionBlocked } from "./session-status-model";

/* Renderer-neutral session chrome signals shared by the web dock and native
   apps: the sub-agents chip and the goal chip. */

export type SessionAgentsSignal = {
  count: number;
  detail: string;
  tone: "running" | "waiting" | "neutral";
};

/** The agents chip for a session's spawned workers, or undefined without any. */
export function sessionAgentsSignal(
  t: OpenGeniText,
  agents: readonly Pick<LineageNode, "session">[],
): SessionAgentsSignal | undefined {
  if (agents.length === 0) return undefined;
  const running = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const paused = agents.filter((node) => node.session.effectiveControl.state === "paused").length;
  return {
    count: agents.length,
    detail:
      running > 0
        ? `${running} running`
        : paused > 0
          ? `${paused} paused`
          : t("sessionAgentsModel.idle"),
    tone: running > 0 ? "running" : paused > 0 ? "waiting" : "neutral",
  };
}

/** One human word for a goal's state, as the web goal pill reads. */
export function sessionGoalStateLabel(t: OpenGeniText, goal: Pick<SessionGoal, "status">): string {
  if (goal.status === "completed") return t("sessionAgentsModel.completed");
  if (goal.status === "paused") return t("sessionAgentsModel.paused");
  return t("sessionAgentsModel.active");
}

/**
 * Compact "waiting for" duration since `iso`, e.g. "<1m", "5m", "10h", "3d".
 * Unlike the rail's relative-time label it never collapses to "now" or a
 * calendar date: a session can wait for input for weeks and the wait should
 * keep reading as a duration. Empty for an unparseable timestamp.
 */
export function formatWaitingSince(iso: string, now: Date = new Date()): string {
  const since = Date.parse(iso);
  if (Number.isNaN(since)) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A sub-agent row's loud trailing word, and the status tone it reads in. */
export type SessionAgentAttention = {
  word: string;
  /** How long it has waited on you ("10h"), or empty. */
  waitingFor: string;
  tone: "failed" | "waiting";
  title?: string | undefined;
};

/**
 * The word a manager must act on in a sub-agent list, shared by the web panel
 * and the phone sheet: a failed agent, one the runtime could not start, one
 * waiting on you (and for how long, from the server's `requiresActionSince`),
 * or a paused one. Null for calm rows, which show their last update instead.
 */
export function sessionAgentAttention(
  t: OpenGeniText,
  session: Pick<SessionSummary, "status" | "requiresActionSince" | "admissionBlock">,
  paused: boolean,
  now: Date = new Date(),
): SessionAgentAttention | null {
  if (session.status === "failed") {
    return { word: t("sessionAgentsModel.failed"), waitingFor: "", tone: "failed" };
  }
  // The runtime could not start its next step: loud, but not a request of you.
  if (sessionAdmissionBlocked(session)) {
    return {
      word: t("sessionAgentsModel.stuck"),
      waitingFor: "",
      tone: "failed",
      title: t("sessionAgentsModel.couldNotStartItsNextStep"),
    };
  }
  if (session.status === "requires_action") {
    const since = session.requiresActionSince ?? null;
    const waitingFor = since ? formatWaitingSince(since, now) : "";
    return {
      word: waitingFor
        ? t("sessionAgentsModel.needsYouFor", { duration: waitingFor })
        : t("sessionAgentsModel.needsYou"),
      waitingFor,
      tone: "waiting",
      ...(since
        ? {
            title: t("sessionAgentsModel.waitingForYourInputSince", {
              time: new Date(since).toLocaleString(),
            }),
          }
        : {}),
    };
  }
  if (paused) return { word: t("sessionAgentsModel.paused"), waitingFor: "", tone: "waiting" };
  return null;
}
