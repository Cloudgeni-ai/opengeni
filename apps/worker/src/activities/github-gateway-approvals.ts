import { listTurnGitHubGatewayApprovals, type GitHubGatewayApproval } from "@opengeni/db";

/**
 * The turn's gateway requests that wait for or carry a decision. A failed
 * read leaves them out rather than failing the turn; gh already told the
 * agent the request waits, and running it again asks again.
 */
export async function turnGitHubGatewayApprovals(
  ...args: Parameters<typeof listTurnGitHubGatewayApprovals>
): Promise<GitHubGatewayApproval[]> {
  try {
    return await listTurnGitHubGatewayApprovals(...args);
  } catch (error) {
    console.warn("github_gateway.approvals_unavailable", {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return [];
  }
}

function reviewArguments(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

/**
 * A `gh` or Git request the personal GitHub gateway held for the person's
 * decision. It is not an open SDK call: approving it lets the same request
 * run when the agent sends it again.
 */
export function githubGatewayApproval(request: GitHubGatewayApproval) {
  const title = request.title ?? `GitHub request (${request.toolName})`;
  return {
    id: request.approvalId,
    name: request.toolName,
    source: "github_gateway" as const,
    requestId: request.requestId,
    arguments: reviewArguments(request.reviewArguments),
    display: { toolName: request.toolName, title: title.slice(0, 512) },
  };
}

/** What the model hears about gateway requests decided since it paused. */
export function githubGatewayContinuationNote(
  requests: readonly GitHubGatewayApproval[],
): string | undefined {
  const decided = requests.filter(
    (request) => request.status === "approved" || request.status === "rejected",
  );
  if (decided.length === 0) return undefined;
  return [
    "GitHub requests from gh or git that waited for the person's approval:",
    ...decided.map((request) => {
      const title = request.title ?? request.toolName;
      return request.status === "approved"
        ? `- Approved: ${title}. Run the same command again, unchanged, to do it.`
        : `- Declined: ${title}. Do not retry it.`;
    }),
  ].join("\n");
}
