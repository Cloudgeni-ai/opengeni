import type { Session } from "@/types";

/**
 * Which Agent learning defaults a chat's own settings sit over: a private
 * chat, a user-scoped one, or any chat in a Personal workspace follows your
 * private defaults; every other chat follows the workspace's.
 */
export function chatLearningScope(
  session: Pick<Session, "tenancy" | "memoryScope">,
  personalWorkspace: boolean,
): "workspace" | "personal" {
  return session.tenancy?.visibility === "private" ||
    session.memoryScope === "user" ||
    personalWorkspace
    ? "personal"
    : "workspace";
}
