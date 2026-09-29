// The scope switchers at the top of the settings rail's Workspace and
// Organization sections. Each one changes only its own scope: the workspace
// switcher lists the workspaces of the current organization (and creates one
// there, by name), the organization switcher lists organizations. Switching
// keeps the same kind of settings page.
import { Building2Icon, CheckIcon, PlusIcon } from "lucide-react";

import { PersonalWorkspaceBadge } from "@/components/personal-workspace-badge";
import { useCreateOrganizationFlow } from "@/components/rail/switcher-block";
import {
  CreateWorkspaceMenuItem,
  OrganizationTile,
  SWITCHER_MENU_CLASS,
  SWITCHER_MENU_ITEM_CLASS,
  SWITCHER_MENU_LABEL_CLASS,
  WorkspaceMenuItems,
  useCreateWorkspaceFlow,
} from "@/components/rail/workspace-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { organizationsForSubject, workspacesInOrg } from "@/lib/org";
import { canCreateWorkspaceInOrganization } from "@/lib/workspaces";

/** The workspace being configured, with the other workspaces of its organization. */
export function SettingsWorkspaceSwitcher({
  workspaceId,
  organizationName,
  onSelect,
}: {
  workspaceId: string;
  organizationName: string;
  onSelect: (workspaceId: string) => void;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const accountId = workspace?.accountId ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const createWorkspace = useCreateWorkspaceFlow({
    workspaceId,
    organization: accountId ? { accountId, label: organizationName } : null,
    onCreated: onSelect,
  });
  const name = workspace?.name ?? "Workspace";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ScopeSwitcherTrigger
            label={name}
            icon={(name.trim()[0] ?? "W").toUpperCase()}
            badge={personal ? <PersonalWorkspaceBadge decorative /> : null}
            aria-label={`${personal ? "Personal workspace" : "Workspace"}: ${name}. Switch workspace in ${organizationName}`}
            className="w-full"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={SWITCHER_MENU_CLASS}>
          <DropdownMenuGroup aria-label={`Workspaces in ${organizationName}`}>
            <DropdownMenuLabel className={SWITCHER_MENU_LABEL_CLASS}>
              Workspaces in {organizationName}
            </DropdownMenuLabel>
            <WorkspaceMenuItems
              workspaces={accountId ? workspacesInOrg(context.workspaces, accountId) : []}
              activeWorkspaceId={workspaceId}
              managedSelfContext={context.managedSelfContext}
              onSelect={onSelect}
            />
            {accountId ? (
              <CreateWorkspaceMenuItem
                organizationLabel={organizationName}
                canCreate={canCreateWorkspaceInOrganization(context.accessContext, accountId)}
                onCreate={createWorkspace.start}
              />
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {createWorkspace.dialog}
    </>
  );
}

/** The organization being configured, with the person's other organizations. */
export function SettingsOrganizationSwitcher({
  accountId,
  organizationName,
  onSelect,
  onCreated,
}: {
  accountId: string;
  organizationName: string;
  /** Open an organization: its settings, through one of its workspaces. */
  onSelect: (accountId: string) => void;
  /** A new organization was created; open its first workspace. */
  onCreated: (workspaceId: string) => void;
}) {
  const context = useAppContext();
  const organizations = organizationsForSubject(context.accessContext, context.workspaces).filter(
    (organization) =>
      organization.accountId === accountId ||
      context.workspaces.some((workspace) => workspace.accountId === organization.accountId),
  );
  const createOrganization = useCreateOrganizationFlow(onCreated);
  if (organizations.length <= 1 && !createOrganization.canCreate) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1">
        <OrganizationTile className="size-6 rounded-md" />
        <p className="truncate text-sm leading-5 font-semibold text-fg" title={organizationName}>
          {organizationName}
        </p>
      </div>
    );
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ScopeSwitcherTrigger
            label={organizationName}
            icon={<Building2Icon aria-hidden="true" className="size-3.5" />}
            aria-label={`Organization: ${organizationName}. Switch organization`}
            className="w-full"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={SWITCHER_MENU_CLASS}>
          <DropdownMenuGroup aria-label="Organizations">
            <DropdownMenuLabel className={SWITCHER_MENU_LABEL_CLASS}>
              Organizations
            </DropdownMenuLabel>
            {organizations.map((organization) => {
              const current = organization.accountId === accountId;
              const label = current ? organizationName : organization.label;
              return (
                <DropdownMenuItem
                  key={organization.accountId}
                  className={SWITCHER_MENU_ITEM_CLASS}
                  aria-current={current ? "true" : undefined}
                  onSelect={() => {
                    if (!current) onSelect(organization.accountId);
                  }}
                >
                  <OrganizationTile />
                  <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                  </span>
                  {current ? <CheckIcon aria-hidden="true" className="size-4 text-brand" /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          {createOrganization.canCreate ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={SWITCHER_MENU_ITEM_CLASS}
                onSelect={(event) => {
                  event.preventDefault();
                  createOrganization.start();
                }}
              >
                <PlusIcon className="size-4" />
                New organization
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {createOrganization.dialog}
    </>
  );
}
