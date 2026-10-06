import { codeSearchDeploymentJudge, type Settings } from "@opengeni/config";
import {
  CODE_SEARCH_CUSTOMER_JUDGE_PROVIDERS,
  resolveCodeSearchJudgeRoute,
  type CodeSearchCustomerJudgeProvider,
  type CodeSearchJudgeRoute,
} from "@opengeni/contracts/code-search";
import {
  organizationModelProviderConnectionActiveForWorkspace,
  workspaceOpenRouterConnectionActive,
  workspaceVercelAiGatewayConnectionActive,
  type Database,
} from "@opengeni/db";

export type CodeSearchCustomerJudgeConnections = {
  workspace: CodeSearchCustomerJudgeProvider[];
  organization: CodeSearchCustomerJudgeProvider[];
};

/**
 * Active OpenRouter and Vercel AI Gateway connections that can pay for the
 * `code_search` judge on the customer's own key: the workspace's own, then
 * the ones its organization shares into it. Metadata only; no key is
 * decrypted. Organization reach follows the same row-level assignment as
 * model inheritance, so a workspace that cannot use an organization
 * connection for models does not see it here either.
 */
export async function loadCodeSearchCustomerJudgeConnections(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<CodeSearchCustomerJudgeConnections> {
  const [workspaceGateway, workspaceOpenRouter, ...organization] = await Promise.all([
    workspaceVercelAiGatewayConnectionActive(db, input.workspaceId),
    workspaceOpenRouterConnectionActive(db, input.workspaceId),
    ...CODE_SEARCH_CUSTOMER_JUDGE_PROVIDERS.map((providerKind) =>
      organizationModelProviderConnectionActiveForWorkspace(db, { ...input, providerKind }),
    ),
  ]);
  return {
    workspace: [
      ...(workspaceGateway ? (["vercel_gateway"] as const) : []),
      ...(workspaceOpenRouter ? (["openrouter"] as const) : []),
    ],
    organization: CODE_SEARCH_CUSTOMER_JUDGE_PROVIDERS.filter((_, index) => organization[index]),
  };
}

/**
 * The judge route for one turn of a session that may use `code_search`, or
 * null when no one may pay for it. Connections are read only when the answer
 * depends on them (`credits_only` funding on a turn not paid with credits).
 */
export async function resolveCodeSearchJudgeRouteForTurn(
  db: Database,
  settings: Pick<Settings, "codeSearchFunding"> & Parameters<typeof codeSearchDeploymentJudge>[0],
  input: { accountId: string; workspaceId: string; turnPaidWithOpenGeniCredits: boolean },
): Promise<CodeSearchJudgeRoute | null> {
  const deployment = codeSearchDeploymentJudge(settings);
  if (!deployment) return null;
  const connections =
    settings.codeSearchFunding === "credits_only" && !input.turnPaidWithOpenGeniCredits
      ? await loadCodeSearchCustomerJudgeConnections(db, input)
      : { workspace: [], organization: [] };
  return resolveCodeSearchJudgeRoute({
    funding: settings.codeSearchFunding,
    deploymentProvider: deployment.provider,
    turnPaidWithOpenGeniCredits: input.turnPaidWithOpenGeniCredits,
    customerConnections: () => connections,
  });
}
