import { apiBaseUrl } from "@/api";
import { OwnAgentSetup } from "@/components/onboarding/own-agent-setup";
import { Section } from "@/components/ui/section";
import { useAppContext } from "@/context";
import { apiOriginFor, buildWithOpengeniPrompt, codingAgentSetup } from "@/lib/coding-agent-setup";
import { composeCodingAgentPrompt, hasAnyProductAnswer } from "@/lib/first-agent";
import {
  markOnboarding,
  onboardingJourneyStorageKey,
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
  return (
    <Section
      title="Use your own coding agent"
      description="Claude Code, Codex or Cursor builds Opengeni into your product with one setup."
    >
      {workspace ? (
        <div className="py-4">
          <OwnAgentSetup
            organizationId={organizationId}
            workspaceId={workspace.id}
            canCreateApiKeys={canCreateApiKeys}
            prompt={
              answers && answers.use === "product" && hasAnyProductAnswer(answers)
                ? composeCodingAgentPrompt(answers, {
                    apiOrigin,
                    organizationId,
                    workspaceId: workspace.id,
                  })
                : buildWithOpengeniPrompt({ apiOrigin, organizationId, workspaceId: workspace.id })
            }
            mcpUrl={
              context.clientConfig.mcpOAuthEnabled === true
                ? codingAgentSetup({
                    mcpOAuthEnabled: true,
                    apiOrigin,
                    workspaceId: workspace.id,
                  }).mcpUrl
                : null
            }
            firstSessionSeen={Boolean(journey?.marks.first_api_session)}
            onMark={(mark) => markOnboarding(journeyKey, mark)}
          />
        </div>
      ) : (
        <p className="py-4 text-sm text-fg-muted">
          Your product's agent runs in a shared workspace. Create one in Workspaces first.
        </p>
      )}
    </Section>
  );
}
