/**
 * One status per agent, for the Agents list and the top of its page
 * (docs/agents.md): whether it can work yet, works on its own, or only
 * answers when asked. Readiness comes from the server's check; triggers from
 * the agent's automations. Pure.
 */
import type { ScheduledTask } from "@opengeni/sdk";

import type { SemanticTone } from "../../../ui/status-dot";

/** What the server's readiness check says is still missing, in the shape the list needs. */
export interface AgentReadinessSummary {
  /** Every required connection, repository and step is in place. */
  ready: boolean;
  /** Names of required connections that aren't connected yet ("PostHog"). */
  missingConnections: readonly string[];
  /** Required steps left in all, connections included. */
  stepsLeft: number;
}

export type AgentStatusKey = "working" | "needs" | "steps_left" | "ready" | "off" | "on_call";

export interface AgentStatus {
  key: AgentStatusKey;
  label: string;
  tone: SemanticTone;
}

export function agentStatus(input: {
  /** Its triggers; null while they load. */
  triggers: readonly Pick<ScheduledTask, "status">[] | null;
  /** Answers when mentioned in Slack. */
  inSlack?: boolean | undefined;
  /** The server's readiness check; null or absent when unknown. */
  readiness?: AgentReadinessSummary | null | undefined;
  /** One of its chats is running now. */
  working?: boolean | undefined;
}): AgentStatus | null {
  if (input.working) return { key: "working", label: "Working now", tone: "progress" };
  const readiness = input.readiness;
  if (readiness && !readiness.ready) {
    if (readiness.missingConnections.length === 1)
      return { key: "needs", label: `Needs ${readiness.missingConnections[0]}`, tone: "attention" };
    const left = Math.max(1, readiness.stepsLeft);
    return {
      key: "steps_left",
      label: left === 1 ? "1 step left" : `${left} steps left`,
      tone: "attention",
    };
  }
  if (input.triggers === null) return null;
  if (input.triggers.length === 0) return { key: "on_call", label: "On call", tone: "neutral" };
  if (input.triggers.some((trigger) => trigger.status === "active"))
    return { key: "ready", label: "Ready", tone: "success" };
  return input.inSlack
    ? { key: "on_call", label: "On call", tone: "neutral" }
    : { key: "off", label: "Off", tone: "neutral" };
}

/** What starts it, for its list row: one trigger's sentence, a count, or that it waits to be asked. */
export function agentStartsWords(
  sentences: readonly string[],
  options: { inSlack?: boolean | undefined } = {},
): string {
  if (sentences.length === 1) return sentences[0]!;
  if (sentences.length > 1) return `${sentences.length} triggers`;
  return options.inSlack
    ? "Answers when asked here or in Slack"
    : "Answers when you ask it in a chat";
}
