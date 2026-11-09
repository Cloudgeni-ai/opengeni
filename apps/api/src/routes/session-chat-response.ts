import type { Session } from "@opengeni/contracts";

/** Runtime configuration has an explicit, authorized read, never a chat-open payload. */
export type SessionChatResponse = Omit<Session, "instructions" | "skills" | "effectiveTools">;

export function sessionChatResponse(session: Session): SessionChatResponse {
  const { instructions: _instructions, skills: _skills, effectiveTools: _tools, ...chat } = session;
  return chat;
}
