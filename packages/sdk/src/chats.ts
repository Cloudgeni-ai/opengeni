import type { CreateSessionRequest } from "./types";

/**
 * Private chats use personal Knowledge and session-only agent reach; shared chats
 * use workspace Knowledge and reach. Isolated adds a separate workspace per user.
 */
export type Chats = "private" | "shared" | "isolated";

/** SDK defaults only: the API still authorizes visibility, agent reach and Knowledge separately. */
export function chatDefaults(
  chats: Chats,
): Required<Pick<CreateSessionRequest, "visibility" | "agentAccess" | "memoryScope">> {
  return chats === "shared"
    ? { visibility: "workspace", agentAccess: "workspace", memoryScope: "workspace" }
    : { visibility: "private", agentAccess: "session", memoryScope: "user" };
}
