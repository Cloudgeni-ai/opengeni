import { apiBaseUrl } from "@/api";
import { OwnAgentSetup } from "@/components/onboarding/own-agent-setup";
import { Section } from "@/components/ui/section";
import { useAppContext } from "@/context";
import { apiOriginFor, buildWithOpengeniPrompt, codingAgentSetup } from "@/lib/coding-agent-setup";
import { composeCodingAgentPrompt, hasAnyProductAnswer } from "@/lib/first-agent";
import {
  markOnboarding,
  onboardingJourneyStorageKey,
  updateOnboardingJourney,
  useOnboardingJourney,
} from "@/lib/onboarding-journey";
import { DEVELOPMENT_WORKSPACE_NAME } from "@/lib/onboarding-paths";

/**
 * Organization settings > Developer: "Use your own coding agent". One click
 * copies the setup (plugin, prompt, a new API key) for Claude Code, Codex or
 * Cursor; the prompt uses the first-run product answers when there are some.
 * It targets the organization's shared Development workspace (API keys reach
 * shared workspaces only), or its first shared workspace.
 */
export function UseOwnCodingAgentSection({
  organizationId,
  canCreateApiKeys,
}: {
  organizationId: string;
  canCreateApiKeys: boolean;
}) {
  const context = useAppContext();
  const journeyKey = onboardingJourneyStorageKey(context.accessContext.subjectId, organizationId);
  const journey = useOnboardingJourney(journeyKey);
  const shared = context.workspaces.filter(
    (workspace) => workspace.accountId === organizationId && workspace.kind === "shared",
  );
  const workspace =
    shared.find((candidate) => candidate.id === journey?.developmentWorkspaceId) ??
    shared.find((candidate) => candidate.name === DEVELOPMENT_WORKSPACE_NAME) ??
    shared[0] ??
    null;
  const apiOrigin = apiOriginFor(apiBaseUrl, window.location.origin);
  const answers = journey?.firstAgent ?? null;
  const ensureWorkspace = async (): Promise<string> => {
    // API keys reach shared workspaces only, so the product's agent gets one,
    // the same Development workspace first run sets up.
    const created = await context.client.createOrganizationWorkspace(organizationId, {
      name: DEVELOPMENT_WORKSPACE_NAME,
      operationId: crypto.randomUUID(),
    });
    updateOnboardingJourney(journeyKey, (current) => ({
      ...current,
      developmentWorkspaceId: created.id,
    }));
    await context.refreshPrincipalAccess();
    return created.id;
  };
  const prompt = (workspaceId: string) =>
    answers && answers.use === "product" && hasAnyProductAnswer(answers)
      ? composeCodingAgentPrompt(answers, { apiOrigin, organizationId, workspaceId })
      : buildWithOpengeniPrompt({ apiOrigin, organizationId, workspaceId });
  return (
    <Section
      title="Use your own coding agent"
      description="Claude Code, Codex or Cursor builds Opengeni into your product with one setup."
    >
      <div className="py-4">
        <OwnAgentSetup
          organizationId={organizationId}
          workspaceId={workspace?.id ?? null}
          ensureWorkspace={ensureWorkspace}
          canCreateApiKeys={canCreateApiKeys}
          prompt={prompt}
          mcpUrl={
            workspace && context.clientConfig.mcpOAuthEnabled === true
              ? codingAgentSetup({ mcpOAuthEnabled: true, apiOrigin, workspaceId: workspace.id })
                  .mcpUrl
              : null
          }
          firstSessionSeen={Boolean(journey?.marks.first_api_session)}
          onMark={(mark) => markOnboarding(journeyKey, mark)}
        />
      </div>
    </Section>
  );
}
