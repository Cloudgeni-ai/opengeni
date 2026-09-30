// Workspace settings pages, rendered inside the settings shell
// (components/settings/workspace-settings-shell.tsx): General, Access,
// Models and API keys. The org/billing console lives at
// Organization settings.
import { NativeIdentityLinkAccounts } from "@/routes/identity-link";
import { Link, useNavigate } from "@tanstack/react-router";
import { PencilIcon, Trash2Icon, UserIcon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { toast } from "sonner";

import { WorkspaceModelsPage } from "@/components/models/workspace-models-page";
import { AgentActivityRow } from "@/components/settings/agent-activity";
import { VideoGenerationPreferenceRow } from "@/components/video-generation-settings";
import { ConnectedAppsDefaultRow } from "@/components/workspace-capability-defaults";
import { DefaultSandboxEnvironmentRow } from "@/components/settings/default-sandbox-environment-row";
import {
  WorkspaceDeveloperSettings,
  WorkspaceSandboxImageRow,
} from "@/components/workspace-developer-settings";
import {
  WorkspaceSettingsContent,
  type WorkspaceSettingsSection,
} from "@/components/settings/workspace-settings-shell";
import {
  useOrganizationWorkspaceAdministration,
  type OrganizationWorkspaceAdministration,
} from "@/components/settings/organization-workspace-administration";
import { VoiceInputPreferenceRow } from "@/components/transcription-settings";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DisabledReasonTooltip, SettingRow, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import type { ModelsView } from "@/lib/models-route";
import { accessSearchOf, accessViewOf, type AccessSearch } from "@/lib/access-route";
import { orgLabel } from "@/lib/org";
import { useOrganizationName } from "@/lib/use-organization-name";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import {
  completeWorkspaceDeletionFollowUp,
  deleteOrganizationWorkspaceWithReconciliation,
} from "@/lib/workspace-deletion";
import { canManageWorkspaceSettings, hasWorkspacePermission } from "@/lib/permissions";
import { WorkspaceApiKeysPage } from "./workspace-api-keys";
import { OrganizationManagedWorkspaceAccess } from "./workspace-managed-access";

export function WorkspaceSettingsRoute({
  workspaceId,
  section,
  modelsAccount,
  modelsView,
  apiKey,
  access,
}: {
  workspaceId: string;
  section: WorkspaceSettingsSection;
  /** Settings > Models: the account page that is open. */
  modelsAccount?: string | undefined;
  /** Settings > Models: the form page that is open. */
  modelsView?: ModelsView | undefined;
  /** Settings > API keys: `new` or the key whose page is open. */
  apiKey?: string | undefined;
  /** Settings > Access: Add people or one person's custom permissions. */
  access?: AccessSearch | undefined;
}) {
  const context = useAppContext();
  const administration = useOrganizationWorkspaceAdministration();
  const activeWorkspace = context.workspaces.some((workspace) => workspace.id === workspaceId);
  if (!activeWorkspace && administration) {
    return (
      <OrganizationManagedWorkspaceSettings
        section={section}
        administration={administration}
        access={access}
      />
    );
  }
  return (
    <OperationalWorkspaceSettingsRoute
      workspaceId={workspaceId}
      section={section}
      modelsAccount={modelsAccount}
      modelsView={modelsView}
      apiKey={apiKey}
      access={access}
    />
  );
}

/** Keeps Settings > Access sub-pages in the URL, so Back and reload land on them. */
function useAccessNavigation(workspaceId: string, access: AccessSearch | undefined) {
  const navigate = useNavigate();
  return {
    view: accessViewOf(access ?? {}),
    onViewChange: (next: ReturnType<typeof accessViewOf>) =>
      void navigate({
        to: "/workspaces/$workspaceId/settings",
        params: { workspaceId },
        search: { section: "access", ...accessSearchOf(next) },
      }),
  };
}

function OperationalWorkspaceSettingsRoute({
  workspaceId,
  section,
  modelsAccount,
  modelsView,
  apiKey,
  access,
}: {
  workspaceId: string;
  section: WorkspaceSettingsSection;
  modelsAccount?: string | undefined;
  modelsView?: ModelsView | undefined;
  apiKey?: string | undefined;
  access?: AccessSearch | undefined;
}) {
  const context = useAppContext();
  const accessNavigation = useAccessNavigation(workspaceId, access);
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationRole =
    context.accessContext.accountGrants.find((grant) => grant.accountId === accountId)?.role ??
    null;
  const canManageOrganizationModels =
    (context.clientConfig.auth.mode === "managedSession" ||
      context.clientConfig.productAccessMode === "local") &&
    (organizationRole === "owner" || organizationRole === "admin");
  // The real name when known (an admin reads it from the organization overview).
  const organizationName = useOrganizationName(accountId, canManageOrganizationModels);
  const organizationLabel = accountId
    ? (organizationName ?? orgLabel(accountId, context.accessContext.accountGrants))
    : "Organization";
  const personal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);
  const canManageSettings = canManageWorkspaceSettings(
    context.accessContext,
    activeWorkspace,
    context.managedSelfContext,
  );
  const canManageMembers = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "members:manage",
  );
  const canManageConnections = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "connections:write",
  );
  const canAdministerWorkspace = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  // canManageOrganizationModels (above) is the same rule as Organization settings >
  // Models: owners and admins in an organization administrator session (or the single
  // local user).
  const [gatewayRevision, setGatewayRevision] = useState(0);

  return (
    <WorkspaceSettingsContent>
      {section === "general" ? (
        <WorkspaceGeneralSettings
          workspaceId={workspaceId}
          organizationLabel={organizationLabel}
          personal={personal}
          canManageSettings={canManageSettings}
          gatewayRevision={gatewayRevision}
        />
      ) : null}

      {section === "access" ? (
        personal ? (
          <PersonalWorkspaceNotice organizationLabel={organizationLabel} />
        ) : (
          <Suspense fallback={<SettingsRowsFallback label="Loading people" />}>
            <LazyMembersSection
              workspaceId={workspaceId}
              canManage={canManageMembers}
              {...accessNavigation}
            />
          </Suspense>
        )
      ) : null}

      {section === "models" ? (
        <WorkspaceModelsPage
          key={`models:${workspaceId}`}
          workspaceId={workspaceId}
          workspaceName={activeWorkspace?.name ?? "this workspace"}
          personal={personal}
          organizationId={accountId}
          organizationName={organizationName ?? "your organization"}
          canManageSettings={canManageSettings}
          canManageConnections={canManageConnections}
          canManageOrganizationModels={canManageOrganizationModels}
          account={modelsAccount}
          view={modelsView}
          onConnectionChange={() => setGatewayRevision((revision) => revision + 1)}
        />
      ) : null}

      {section === "api-keys" ? (
        <WorkspaceApiKeysPage key={workspaceId} workspaceId={workspaceId} keyParam={apiKey} />
      ) : null}

      {section === "developer" ? (
        <WorkspaceDeveloperSettings
          client={context.client}
          workspaceId={workspaceId}
          canManage={canAdministerWorkspace}
          personal={personal}
        />
      ) : null}
    </WorkspaceSettingsContent>
  );
}

/* ----------------------------------------------------------------------------
   General: the workspace, agent activity, new session defaults, delete.
   -------------------------------------------------------------------------- */

function WorkspaceGeneralSettings({
  workspaceId,
  organizationLabel,
  personal,
  canManageSettings,
  gatewayRevision,
}: {
  workspaceId: string;
  organizationLabel: string;
  personal: boolean;
  canManageSettings: boolean;
  gatewayRevision: number;
}) {
  const context = useAppContext();
  const { captureWorkspaceInvocation, ownsWorkspaceInvocation } = context;
  const navigate = useNavigate();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const canRename =
    activeWorkspace !== null &&
    hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const canDeleteWorkspace = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  // Deleting the account's only workspace is refused server-side; disable the
  // affordance when this is the only workspace in the active account.
  const isOnlyWorkspaceInAccount =
    context.workspaces.filter((workspace) => workspace.accountId === accountId).length <= 1;
  const organizationSettingsWorkspaceId = accountId ? workspaceId : undefined;
  const [renaming, setRenaming] = useState(false);

  async function rename(name: string): Promise<boolean> {
    if (name === activeWorkspace?.name) return true;
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    const renamed = await context.renameWorkspace(workspaceId, name);
    if (!renamed || !ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
    toast.success(`Renamed to ${renamed.name}`);
    return true;
  }

  async function deleteWorkspace(): Promise<boolean> {
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    // Pick where to land BEFORE the cache drops this workspace.
    const remaining = context.workspaces.filter((workspace) => workspace.id !== workspaceId);
    const next =
      remaining.find((workspace) => workspace.accountId === accountId) ?? remaining[0] ?? null;
    const deleted = await context.deleteWorkspace(workspaceId);
    if (!deleted) {
      return false;
    }
    if (!context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
    context.resetSessionView();
    if (next) {
      await navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: next.id },
        replace: true,
      });
    } else {
      await navigate({ to: "/", replace: true });
    }
    return true;
  }

  if (!activeWorkspace) return <SettingsRowsFallback label="Loading settings" />;

  return (
    <SectionStack>
      <Section title="Details">
        <SettingRow
          label="Name"
          description={<RowValue>{activeWorkspace.name}</RowValue>}
          control={
            // A Personal workspace keeps its name: no button that could only
            // say it isn't allowed.
            personal ? undefined : (
              <DisabledReasonTooltip
                reason={canRename ? undefined : "Only workspace admins can rename it."}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={canRename ? undefined : "true"}
                  aria-label={`Rename workspace ${activeWorkspace.name}`}
                  onClick={() => {
                    if (canRename) setRenaming(true);
                  }}
                  className={canRename ? "pointer-coarse:h-11" : "opacity-50 pointer-coarse:h-11"}
                >
                  <PencilIcon aria-hidden="true" />
                  Rename
                </Button>
              </DisabledReasonTooltip>
            )
          }
        />
        <SettingRow
          label="Type"
          description={
            <RowValue>
              {personal ? "Personal · only you" : "Shared"} ·{" "}
              {organizationSettingsWorkspaceId ? (
                <Link
                  to="/workspaces/$workspaceId/organization"
                  params={{ workspaceId: organizationSettingsWorkspaceId }}
                  className="text-brand underline-offset-2 hover:underline"
                >
                  {organizationLabel}
                </Link>
              ) : (
                organizationLabel
              )}
            </RowValue>
          }
        />
        <SettingRow
          label="Workspace ID"
          description={
            <span className="mt-0.5 flex min-w-0">
              <CopyField value={workspaceId} label="workspace ID" truncate="middle" />
            </span>
          }
        />
      </Section>
      <RenameWorkspaceDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={activeWorkspace.name}
        onRename={rename}
      />

      <Section title="Agent activity">
        <AgentActivityRow
          key={workspaceId}
          control={activeWorkspace.inferenceControl}
          canManage={canManageSettings}
          onControl={async (action) => {
            await context.setWorkspaceInferenceControl(workspaceId, action);
          }}
          onRefresh={() => context.refreshWorkspace(workspaceId)}
          onTimer={async (request, expectedRevision) => {
            const accepted = context.captureWorkspaceInvocation(workspaceId);
            if (!accepted) return;
            await context.client.setWorkspacePauseTimer(workspaceId, {
              ...request,
              expectedRevision,
              clientEventId: crypto.randomUUID(),
            });
            if (context.ownsWorkspaceInvocation(workspaceId, accepted))
              await context.refreshWorkspace(workspaceId);
          }}
        />
      </Section>

      <Section
        title="New session defaults"
        description="Applied when someone starts a new session in this workspace."
      >
        <DefaultSandboxEnvironmentRow workspaceId={workspaceId} />
        <VoiceInputPreferenceRow workspaceId={workspaceId} canManage={canManageSettings} />
        <VideoGenerationPreferenceRow
          workspaceId={workspaceId}
          canManage={canManageSettings}
          refreshKey={gatewayRevision}
          onConnectGateway={() =>
            void navigate({
              to: "/workspaces/$workspaceId/settings",
              params: { workspaceId },
              search: { section: "models", view: "connect:vercel" },
            })
          }
        />
        <WorkspaceSandboxImageRow
          client={context.client}
          workspaceId={workspaceId}
          canManage={canRename}
        />
        <CodeSearchPreferenceRow workspaceId={workspaceId} canManage={canManageSettings} />
        <ConnectedAppsDefaultRow workspaceId={workspaceId} canManage={canManageSettings} />
      </Section>

      <NativeIdentityLinkAccounts workspaceId={workspaceId} />

      {/* A personal workspace belongs to its person's membership and is never
          deleted from here, so its settings show no delete section at all. */}
      {personal ? null : (
        <DangerZone
          workspaceName={activeWorkspace.name}
          canDelete={canDeleteWorkspace}
          isOnlyWorkspaceInAccount={isOnlyWorkspaceInAccount}
          onDelete={deleteWorkspace}
        />
      )}
    </SectionStack>
  );
}

/** A row's current value, in the description slot: 14px, full strength. */
function RowValue({ children }: { children: React.ReactNode }) {
  return <span className="mt-0.5 block text-sm leading-5 break-words text-fg">{children}</span>;
}

function SettingsRowsFallback({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <SettingRowSkeleton />
      <SettingRowSkeleton />
      <SettingRowSkeleton />
    </div>
  );
}

const NAME_MAX = 120;

function RenameWorkspaceDialog({
  open,
  onOpenChange,
  name,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** Resolves false when the rename didn't happen (the context already told the user why). */
  onRename: (name: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string>();
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(name);
          setError(undefined);
        }
        onOpenChange(next);
      }}
      size="sm"
      title="Rename workspace"
      description="Everyone with access sees the new name."
      submitLabel="Save name"
      pendingLabel="Saving…"
      onSubmit={async () => {
        const trimmed = value.trim();
        if (!trimmed) {
          setError("Name the workspace.");
          return false;
        }
        if (trimmed.length > NAME_MAX) {
          setError(`Use ${NAME_MAX} characters or fewer.`);
          return false;
        }
        return await onRename(trimmed);
      }}
    >
      <FieldStack>
        <Field
          label="Name"
          error={error}
          hint="Shown in the workspace switcher, invitations and Slack."
        >
          <TextInput
            value={value}
            maxLength={NAME_MAX}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            placeholder="Workspace name"
            suppressAutofill
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}

/**
 * Jev-backed code_search agent tool. Shown only when the deployment offers it.
 * "Default" follows the deployment (which may give the tool to half of all
 * sessions during an experiment). Each session keeps the choice it was created
 * with, so its cached prompt stays stable; Off also pauses the tool in running
 * sessions until it is switched back.
 */
function CodeSearchPreferenceRow({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const context = useAppContext();
  const capability = context.clientConfig.codeSearch;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const explicit = workspace?.settings?.codeSearchEnabled;
  const value = explicit === true ? "on" : explicit === false ? "off" : "default";
  const [saving, setSaving] = useState(false);
  if (capability?.available !== true) return null;
  const defaultPhrase =
    capability.workspaceDefault === "on"
      ? "Default turns it on"
      : capability.workspaceDefault === "split"
        ? "Default gives it to half of new sessions"
        : "Default leaves it off";

  async function choose(next: "default" | "on" | "off") {
    if (next === value) return;
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        codeSearchEnabled: next === "default" ? null : next === "on",
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success("Fast code search saved");
      }
    } catch {
      if (context.ownsWorkspaceInvocation(workspaceId, acceptedTransition))
        toast.error("Couldn't update fast code search");
    } finally {
      setSaving(false);
    }
  }

  const reason = canManage ? undefined : "Only workspace admins can change this.";
  return (
    <SettingRow
      label="Fast code search"
      description={`Agents find code in one step. ${defaultPhrase}; Off also pauses it in running sessions.`}
      controlWidth="auto"
      control={
        <SegmentedControl
          size="sm"
          value={value}
          onValueChange={(next) => void choose(next as "default" | "on" | "off")}
          options={[
            { value: "default", label: "Default" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ].map((option) => ({
            ...option,
            disabled: saving || !canManage,
            ...(reason ? { disabledReason: reason } : {}),
          }))}
        />
      }
    />
  );
}

/* ----------------------------------------------------------------------------
   Delete workspace: the last section of General.
   -------------------------------------------------------------------------- */

/** Delete workspace: a quiet last section that confirms with the typed name. */
export function DangerZone(props: {
  workspaceName: string;
  canDelete: boolean;
  isOnlyWorkspaceInAccount: boolean;
  onDelete: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const deleteInFlight = useRef(false);

  const disabledReason = !props.canDelete
    ? "Only workspace admins can delete this workspace."
    : props.isOnlyWorkspaceInAccount
      ? "You can't delete an organization's only workspace. Create another one first."
      : null;

  async function confirmDelete(): Promise<boolean> {
    if (deleteInFlight.current) return false;
    deleteInFlight.current = true;
    // onDelete surfaces expected mutation errors. Close explicitly on success
    // because a best-effort post-delete navigation can leave this route mounted.
    try {
      const ok = await props.onDelete();
      if (ok) {
        toast.success(`Deleted ${props.workspaceName}`);
        setOpen(false);
      }
      return ok;
    } catch (error) {
      throw new Error(`Couldn't delete the workspace. ${userErrorText(error, "Try again.")}`, {
        cause: error,
      });
    } finally {
      deleteInFlight.current = false;
    }
  }

  return (
    <Section
      title="Delete workspace"
      description={
        disabledReason ??
        `Deletes ${props.workspaceName} for everyone, with its sessions, schedules, variable sets, knowledge, files and API keys.`
      }
      action={
        // When something blocks the delete, the description says what and who
        // can fix it; a ghosted button next to it would only read as broken.
        disabledReason ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            className="text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
          >
            <Trash2Icon aria-hidden="true" />
            Delete
          </Button>
        )
      }
    >
      {disabledReason ? null : (
        <DestructiveConfirm
          open={open}
          onOpenChange={(next) => {
            if (!deleteInFlight.current) setOpen(next);
          }}
          variant="type-to-confirm"
          title={`Delete ${props.workspaceName}?`}
          consequences={[
            `Deletes every session, schedule, variable set, knowledge entry, file and API key in ${props.workspaceName}.`,
            "Everyone loses access to it. Their other workspaces aren't affected.",
            "Running sessions, video generations, background commands and live sandboxes must finish first.",
            "This can't be undone.",
          ]}
          confirmText={props.workspaceName}
          confirmPlaceholder="Workspace name"
          confirmLabel="Delete workspace"
          pendingLabel="Deleting…"
          onConfirm={confirmDelete}
        />
      )}
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Organization management: an organization admin who manages this workspace
   without access to its content. Name and delete on General, and Access.
   -------------------------------------------------------------------------- */

function OrganizationManagedWorkspaceSettings({
  section,
  administration,
  access,
}: {
  section: WorkspaceSettingsSection;
  administration: OrganizationWorkspaceAdministration;
  access?: AccessSearch | undefined;
}) {
  const context = useAppContext();
  const accessNavigation = useAccessNavigation(administration.workspace.id, access);
  const navigate = useNavigate();
  const { organizationId, overview, workspace, refresh } = administration;
  const [renaming, setRenaming] = useState(false);

  async function rename(nextName: string): Promise<boolean> {
    if (nextName === workspace.name) return true;
    try {
      await context.client.updateOrganizationWorkspace(organizationId, workspace.id, {
        name: nextName,
        expectedUpdatedAt: workspace.updatedAt,
        operationId: crypto.randomUUID(),
      });
      toast.success(`Renamed to ${nextName}`);
      refresh();
      return true;
    } catch (error) {
      throw new Error(`Couldn't rename the workspace. ${userErrorText(error, "Try again.")}`, {
        cause: error,
      });
    }
  }

  async function deleteWorkspace(): Promise<boolean> {
    try {
      const currentOverview = await deleteOrganizationWorkspaceWithReconciliation({
        client: context.client,
        organizationId,
        workspaceId: workspace.id,
      });
      const next =
        currentOverview?.workspaces.find((candidate) => candidate.id !== workspace.id) ?? null;
      const followUp = await completeWorkspaceDeletionFollowUp({
        refreshAccess: async () => await context.revalidatePrincipalAccess(),
        navigate: async () => {
          if (next) {
            await navigate({
              to: "/workspaces/$workspaceId/organization",
              params: { workspaceId: next.id },
              search: { section: "overview" },
              replace: true,
            });
          } else {
            await navigate({ to: "/", replace: true });
          }
        },
      });
      if (followUp.status === "failed") {
        toast.warning("Workspace deleted, but the page may be out of date", {
          description: "Reload to refresh your workspace access.",
        });
      }
      return true;
    } catch (error) {
      toast.error("Couldn't delete the workspace", {
        description: userErrorText(error),
      });
      return false;
    }
  }

  const scopeNotice = (
    <Notice tone="muted" title="You manage this workspace for the organization">
      You can rename it, change who has access and delete it. This doesn't give you access to its
      sessions, files, credentials or integrations.
    </Notice>
  );

  if (section !== "general" && section !== "access") {
    return (
      <WorkspaceSettingsContent>
        <Notice tone="muted" title="Workspace access required">
          Organization administrators can manage the name, access and deletion here without
          receiving access to workspace content.
        </Notice>
      </WorkspaceSettingsContent>
    );
  }

  return (
    <WorkspaceSettingsContent>
      {accessNavigation.view ? null : <div className="mb-6">{scopeNotice}</div>}
      {section === "general" ? (
        <SectionStack>
          <Section title="Details">
            <SettingRow
              label="Name"
              description={<RowValue>{workspace.name}</RowValue>}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRenaming(true)}
                  className="pointer-coarse:h-11"
                >
                  <PencilIcon aria-hidden="true" />
                  Rename
                </Button>
              }
            />
            <SettingRow
              label="Type"
              description={<RowValue>Shared · {overview.organization.name}</RowValue>}
            />
            <SettingRow
              label="Workspace ID"
              description={
                <span className="mt-0.5 flex min-w-0">
                  <CopyField value={workspace.id} label="workspace ID" truncate="middle" />
                </span>
              }
            />
          </Section>
          <RenameWorkspaceDialog
            open={renaming}
            onOpenChange={setRenaming}
            name={workspace.name}
            onRename={rename}
          />
          <DangerZone
            workspaceName={workspace.name}
            canDelete
            isOnlyWorkspaceInAccount={false}
            onDelete={deleteWorkspace}
          />
        </SectionStack>
      ) : (
        <OrganizationManagedWorkspaceAccess administration={administration} {...accessNavigation} />
      )}
    </WorkspaceSettingsContent>
  );
}

function PersonalWorkspaceNotice({ organizationLabel }: { organizationLabel: string }) {
  return (
    <Notice tone="muted" icon={<UserIcon />} title="Only you can use your Personal workspace">
      This workspace is your owner-only space inside {organizationLabel}. Organization
      administrators and other members do not gain access to its sessions or content.
    </Notice>
  );
}

const LazyMembersSection = lazy(async () => {
  const module = await import("./workspace-members-section");
  return { default: module.MembersSection };
});
