/**
 * "Ask about this meeting" starts an ordinary chat whose first message is the
 * question with the meeting attached: its title and id, and which tool reads
 * it, so the agent reads that exact meeting instead of searching for it.
 */
export function meetingQuestionMessage(
  question: string,
  meeting: { id: string; title: string | null },
): string {
  const title = meeting.title?.trim();
  const named = title
    ? `the meeting “${title}” (meeting id ${meeting.id})`
    : `meeting ${meeting.id}`;
  return `${question.trim()}\n\nAbout ${named}. Read it with meeting_read.`;
}

/**
 * Who can see the chat that asks about a meeting. The chat quotes the
 * meeting, so it may only be as open as the meeting itself: a meeting shared
 * with the workspace keeps the workspace's usual chat visibility, and any
 * other meeting (private, or one we could not read) gets a private chat.
 */
export function meetingQuestionVisibility(
  meeting: { visibility: "private" | "workspace" } | null,
): "private" | undefined {
  return meeting?.visibility === "workspace" ? undefined : "private";
}
