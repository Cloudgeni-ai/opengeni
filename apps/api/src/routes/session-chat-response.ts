import type { Session } from "@opengeni/contracts";

/** Runtime configuration has an explicit, authorized read, never a chat-open payload. */
export type SessionChatResponse = Omit<Session, "instructions" | "skills" | "effectiveTools">;

/** Accepts a Session read without its Skill folders, which this projection never carries. */
export function sessionChatResponse(
  session: Omit<Session, "skills"> & Partial<Pick<Session, "skills">>,
): SessionChatResponse {
  const { instructions: _instructions, skills: _skills, effectiveTools: _tools, ...chat } = session;
  return chat;
}
