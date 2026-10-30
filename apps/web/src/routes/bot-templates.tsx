// Bot templates: where a new bot starts. The page lives in the shared app
// package; this route owns the scroll frame.
import { useNavigate } from "@tanstack/react-router";
import { BotTemplatesPage } from "@opengeni/react/app/components/bots/bot-templates-page";
import { useAppContext } from "@opengeni/react/app/app-context";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { ContentPage } from "@opengeni/react/ui/content-layout";

/** Detail pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

/** The Slack page's create form, prefilled from a template (`SLACK_AGENT_TEMPLATE_PARAM`). */
export function slackAgentFromTemplateHref(workspaceId: string, templateId: string): string {
  const search = new URLSearchParams({ open: "integration:slack", slackAgentTemplate: templateId });
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins?${search}`;
}

export function BotTemplatesRoute({ workspaceId }: { workspaceId: string }) {
  const { accessContext, workspaces, managedSelfContext } = useAppContext();
  const navigate = useNavigate();
  const workspace = workspaces.find((row) => row.id === workspaceId) ?? null;
  // Only people who can create Slack agents here: admins of a shared workspace.
  const canCreateSlackAgent =
    workspace !== null &&
    !isPersonalWorkspace(workspace, managedSelfContext) &&
    hasWorkspacePermission(accessContext, workspaceId, "workspace:admin");
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <BotTemplatesPage
        workspaceId={workspaceId}
        onUseInSlack={
          canCreateSlackAgent
            ? (template) =>
                void navigate({ href: slackAgentFromTemplateHref(workspaceId, template.id) })
            : undefined
        }
      />
    </ContentPage>
  );
}
