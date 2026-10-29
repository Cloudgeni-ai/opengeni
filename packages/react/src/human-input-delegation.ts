import type { HumanInputQuestion, SessionEvent } from "@opengeni/sdk";

import type { OpenGeniText } from "./messages/runtime";

/* "Let the agent decide" on a sub-session's question hands it to the agent of
   the chat the person is looking at: a user message whose model-only context
   names the exact request, so the agent answers it with
   session_human_input_respond. The first line of that context is a marker the
   web app reads back to show the card as decided by the agent. */

export type HumanInputDelegation = {
  /** The sub-session that asked. */
  sessionId: string;
  requestId: string;
};

const MARKER = "opengeni:human-input-delegation ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUESTION_PREVIEW_CHARS = 600;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function questionTitle(question: HumanInputQuestion): string {
  return oneLine(question.label || question.prompt, 200);
}

/** The message the person sends their agent: short visible text, exact model context. */
export function humanInputDelegationMessage(
  t: OpenGeniText,
  input: {
    sessionId: string;
    sessionTitle: string;
    request: { id: string; questions: readonly HumanInputQuestion[] };
  },
): { text: string; modelContext: string } {
  const first = input.request.questions[0];
  const more = input.request.questions.length - 1;
  const title = first ? questionTitle(first) : "";
  const text =
    more > 0
      ? t("humanInputDelegation.messageWithMore", { question: title, more })
      : t("humanInputDelegation.message", { question: title });
  const questions = input.request.questions.map((question) => {
    const options = question.options.length
      ? ` Options: ${question.options.map((option) => `${option.id} (${oneLine(option.label, 120)})`).join(", ")}.`
      : "";
    return `- ${question.id} [${question.kind}${question.required ? ", required" : ""}]: ${oneLine(question.prompt, QUESTION_PREVIEW_CHARS)}${options}`;
  });
  const modelContext = [
    `${MARKER}${JSON.stringify({ sessionId: input.sessionId, requestId: input.request.id })}`,
    `The person let you decide this question from the sub-session "${oneLine(input.sessionTitle, 200)}" (sessionId ${input.sessionId}, requestId ${input.request.id}):`,
    ...questions,
    "Answer it now with session_human_input_respond using your best judgement and what you know from this task. If it asks for agent work you can do, such as starting a reviewer or worker, do that work and then answer. Then say in one short sentence what you chose. If it was already answered, say so briefly.",
  ].join("\n");
  return { text, modelContext };
}

/**
 * The question part of a hand-off message's visible text, without the
 * "Let the agent decide:" lead-in. Text in another form is returned as is.
 */
export function humanInputDelegationQuestionText(t: OpenGeniText, text: string): string {
  const marker = "\u0000";
  const [lead = ""] = t("humanInputDelegation.message", { question: marker }).split(marker);
  return lead && text.startsWith(lead) ? text.slice(lead.length) : text;
}

/** The request a user message handed to its agent, or null for any other message. */
export function parseHumanInputDelegation(modelContext: unknown): HumanInputDelegation | null {
  if (typeof modelContext !== "string" || !modelContext.startsWith(MARKER)) return null;
  const line = modelContext.slice(MARKER.length).split("\n", 1)[0] ?? "";
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    const requestId = typeof value.requestId === "string" ? value.requestId : "";
    return UUID.test(sessionId) && UUID.test(requestId)
      ? { sessionId: sessionId.toLowerCase(), requestId: requestId.toLowerCase() }
      : null;
  } catch {
    return null;
  }
}

/** Request ids this chat's messages handed to its agent. */
export function delegatedHumanInputRequestIds(events: readonly SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "user.message") continue;
    const payload = event.payload as { modelContext?: unknown } | null;
    const delegation = parseHumanInputDelegation(payload?.modelContext);
    if (delegation) ids.add(delegation.requestId);
  }
  return ids;
}
