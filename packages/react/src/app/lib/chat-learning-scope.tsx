import type { Session } from "../types";

/**
 * Which Agent learning defaults a chat's own settings sit over: a private
 * chat or a user-scoped one follows your private defaults; every other chat
 * follows the workspace's, in a Personal workspace too.
 */
export function chatLearningScope(
  session: Pick<Session, "tenancy" | "memoryScope">,
): "workspace" | "personal" {
  return session.tenancy?.visibility === "private" || session.memoryScope === "user"
    ? "personal"
    : "workspace";
}
