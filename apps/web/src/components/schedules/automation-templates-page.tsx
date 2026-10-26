/**
 * Templates: where a new automation can start. The built-in ones, then the
 * ones people saved in this workspace from an automation's page. Using one
 * opens New automation filled in from it; nothing runs until it is created.
 * Whoever saved a template, or an admin, can rename or delete it.
 */
import { useState } from "react";
import { LayoutTemplateIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AutomationTemplateDialog,
  AutomationTemplateList,
  automationTemplateOfSaved,
  automationTemplatesFor,
  type AutomationTemplate,
} from "@opengeni/react/automations";
import { apiErrorDetails, userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { Notice } from "@opengeni/react/ui/notice";
import { useMinuteNow } from "@opengeni/react/ui/relative-time";
import { useAppContext } from "@opengeni/react/app/app-context";
import type { WorkspaceAutomationTemplate } from "@opengeni/sdk";

import { scheduleTemplates } from "./schedule-model";
import { newAutomationPath, useScheduleAccess, useScheduleNavigation } from "./schedule-parts";
import { templateIcon, useWorkspaceTemplates } from "./use-automation-templates";
import { useEventSourceLogo, useEventTriggersEnabled } from "./use-event-sources";

export function AutomationTemplatesPage({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const eventTriggers = useEventTriggersEnabled();
  const logo = useEventSourceLogo();
  const now = new Date(useMinuteNow());
  const saved = useWorkspaceTemplates(workspaceId);
  const [renaming, setRenaming] = useState<WorkspaceAutomationTemplate | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceAutomationTemplate | null>(null);

  const builtIn = scheduleTemplates(eventTriggers);
  const savedTemplates = automationTemplatesFor(
    (saved.templates ?? []).map(automationTemplateOfSaved),
    {
      eventTriggers,
      workspaceEvents: true,
    },
  );
  const use = (template: AutomationTemplate) => go.create({ template: template.id });
  const href = (template: AutomationTemplate) => newAutomationPath(workspaceId, template.id);
  const menu = (template: AutomationTemplate) => {
    const entry = saved.templates?.find((candidate) => candidate.id === template.id);
    if (!entry || entry.viewerAccess !== "manage" || !access.canManage) return undefined;
    return (
      <>
        <DropdownMenuItem onSelect={() => setRenaming(entry)}>Rename</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(entry)}>
          Delete
        </DropdownMenuItem>
      </>
    );
  };

  return (
    <DetailPage back={{ label: "Automations", onClick: go.list }}>
      <DetailPageHeader
        leading={<LogoTile name="Templates" icon={<LayoutTemplateIcon />} />}
        title="Templates"
        meta={["Start an automation from one, then make it your own"]}
      />
      {!access.canManage ? (
        <Notice className="mt-6">
          You need permission to manage automations in this workspace to start one from a template.
          Ask a workspace admin.
        </Notice>
      ) : null}
      <DetailSection title="Built in">
        <AutomationTemplateList
          label="Built-in templates"
          templates={builtIn}
          icon={templateIcon}
          sourceLogo={logo}
          onUse={use}
          href={access.canManage ? href : undefined}
          now={now}
        />
      </DetailSection>
      {saved.supported ? (
        <DetailSection
          title="Saved in this workspace"
          description="Anyone in the workspace can start from these. Save one from an automation's page."
          className="pt-0"
        >
          {saved.templates === undefined ? (
            <RowList label="Saved templates" variant="catalog" busy>
              <ListRowSkeleton count={2} />
            </RowList>
          ) : saved.error && saved.templates.length === 0 ? (
            <ErrorMessage
              title="Couldn't load the saved templates"
              {...apiErrorDetails(saved.error)}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={saved.reload}
                  className="pointer-coarse:h-11"
                >
                  Try again
                </Button>
              }
            >
              Check your connection, then try again.
            </ErrorMessage>
          ) : savedTemplates.length === 0 ? (
            <p className="m-0 text-sm leading-5 text-fg-muted">
              None yet. Open an automation and choose Save as template.
            </p>
          ) : (
            <AutomationTemplateList
              label="Saved templates"
              templates={savedTemplates}
              sourceLogo={logo}
              onUse={use}
              href={access.canManage ? href : undefined}
              menu={menu}
              menuLabel={(template) => `More actions for the ${template.name} template`}
              now={now}
            />
          )}
        </DetailSection>
      ) : null}
      <AutomationTemplateDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        mode="rename"
        initial={{ name: renaming?.name ?? "", description: renaming?.description ?? "" }}
        onSubmit={async (values) => {
          if (!renaming) return;
          const updated = await client.updateAutomationTemplate(workspaceId, renaming.id, values);
          saved.replace((current) =>
            current.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete the “${deleting?.name ?? ""}” template?`}
        description="Automations made from it keep running."
        confirmLabel="Delete template"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return true;
          try {
            await client.deleteAutomationTemplate(workspaceId, deleting.id);
            saved.replace((current) => current.filter((entry) => entry.id !== deleting.id));
            toast.success("Template deleted", { description: deleting.name });
            return true;
          } catch (error) {
            toast.error("Couldn't delete the template", { description: userErrorText(error) });
            return false;
          }
        }}
      />
    </DetailPage>
  );
}
