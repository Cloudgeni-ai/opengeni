import { claudeProviderId } from "@opengeni/config";
import type { Database } from "./database";
import { readSubscriptionCoreRouteFunding } from "./subscription-core/route-readiness";

/**
 * Liveness of a Claude subscription custom model at a fresh-admission fence
 * (design 5.3, mapping table, custom-model admission "After C3"). The legacy
 * Claude pool is deleted (C4), so only the shared core answers: the
 * workspace's provider route must be `core` (the 0720 receipt and an enabled
 * organization cutover; maintenance refuses) and a serviceable shared Claude
 * connection that the workspace's effective source admits must allow the
 * exact product model. No acting subject is consulted (shared capacity only),
 * so no personal connection and no frozen v1 authority admits it. Without a
 * receipt the answer is false: fail closed.
 */
export async function subscriptionCoreClaudeAdmitsCustomModel(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    scope: "workspace" | "organization";
    upstreamModelId: string;
  },
): Promise<boolean> {
  const answer = await readSubscriptionCoreRouteFunding(db, {
    provider: "claude",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: null,
    productModelId: `${claudeProviderId("claude_subscription", input.scope)}/${input.upstreamModelId}`,
  });
  return answer.route === "core" && answer.value;
}
