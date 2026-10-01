/** One durable, same-logical-turn handoff, not a retry of model/tool effects. */
export function finalReplyNudge(turnId: string) {
  return {
    type: "message" as const,
    role: "developer" as const,
    content: [
      {
        type: "input_text" as const,
        text: `[Runtime final-reply handoff for turn ${turnId}]\nYour final user-facing answer was empty. Reply to the user now with the requested deliverable or a concise outcome and its retained artifact link. Goal evidence is a short ledger proof, not the answer, and goal_complete does not deliver a chat reply. Use the completed work and tool results already in history; do not repeat completed tools or restart the task. If this is a late child result after goal completion, integrate material new findings and deliver any still-missing handoff. Do not change the completed goal or invent a result.`,
      },
    ],
  };
}

export function hasFinalReplyNudge(history: readonly unknown[], turnId: string): boolean {
  const text = finalReplyNudge(turnId).content[0]!.text;
  return history.some((item) => {
    const message = item as { role?: unknown; content?: unknown } | null;
    return (
      message?.role === "developer" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part: { type?: unknown; text?: unknown }) =>
          part?.type === "input_text" && part.text === text,
      )
    );
  });
}

export function needsFinalReply(input: {
  output: unknown;
  inputWaitYielded: boolean;
  interrupted: boolean;
  maintenance: boolean;
  toolsExecuted: boolean;
  completedGoal: boolean;
}): boolean {
  return (
    typeof input.output === "string" &&
    input.output.trim().length === 0 &&
    !input.inputWaitYielded &&
    !input.interrupted &&
    !input.maintenance &&
    (input.toolsExecuted || input.completedGoal)
  );
}
