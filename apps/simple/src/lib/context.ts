import { relativeTime, type Agent } from "./agents";

export type ReplyLength = "short" | "detailed";

/**
 * Message context attached to every message a person sends: who the speaker
 * is, which other agents exist (so they can find and message each other), and
 * what is connected. It rides on the newest user message, never on
 * instructions, so the provider prompt cache stays warm.
 */
export function buildModelContext(input: {
  self: Agent;
  agents: Agent[];
  connections: string[];
  replyLength: ReplyLength;
  tellMore?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(
    `[App context] You are "${input.self.name}" (session ${input.self.id})` +
      (input.self.role === "main" ? ", the main agent." : "."),
  );
  const others = input.agents.filter((agent) => agent.id !== input.self.id);
  if (others.length) {
    lines.push(
      "Other agents in this app (message them with session_send_message, read them with session_events):",
    );
    for (const agent of others.slice(0, 30)) {
      const state = agent.needsYou
        ? "waiting for the user"
        : agent.working
          ? "working now"
          : `last active ${relativeTime(agent.lastActivityAt)}`;
      const description = agent.description ? ` - ${agent.description}` : "";
      lines.push(
        `- ${agent.name} (${agent.id})${description} [${state}${agent.shared ? ", shared" : ""}]`,
      );
    }
  } else {
    lines.push("There are no other agents yet.");
  }
  lines.push(
    input.connections.length
      ? `Connected services: ${input.connections.join(", ")}.`
      : "No services are connected yet.",
  );
  lines.push(
    input.replyLength === "detailed"
      ? "Reply style preference: the user likes fuller answers, but stay clear and skimmable."
      : "Reply style preference: short and direct.",
  );
  if (input.tellMore) {
    lines.push(
      `The user pressed "Tell me more" on this part of your earlier reply:\n> ${input.tellMore
        .slice(0, 1200)
        .replace(
          /\n/g,
          "\n> ",
        )}\nExpand on it with real depth: reasons, details, examples, trade-offs. Do not repeat what you already said.`,
    );
  }
  return lines.join("\n");
}
