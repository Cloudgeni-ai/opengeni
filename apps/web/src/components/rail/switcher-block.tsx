// The rail's top switcher: a muted Organization line over a prominent Workspace
// line. The org line opens organization switching, creation, and settings; the
// workspace line lists the current org's workspaces plus workspace actions.
// Collapsed, the whole block reduces to a workspace-initial avatar that opens
// the same workspace menu.
import { Link } from "@tanstack/react-router";
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { useRail } from "@/components/rail/rail-context";
import {
  activeOrganizationLabel,
  WorkspaceSwitcherMenu,
} from "@/components/rail/workspace-switcher";
import { organizationsForSubject, type OrgOption } from "@/lib/org";
import { canCreateAdditionalOrganization } from "@/lib/managed-self-context";

const LazyCreateOrganizationDialog = lazy(() =>
  import("@/components/rail/create-organization-dialog").then((module) => ({
    default: module.CreateOrganizationDialog,
  })),
);

export const WORKSPACE_SWITCHER_GRID_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 px-3 pt-1";

export function SwitcherBlock() {
  const context = useAppContext();
  const rail = useRail();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === rail.workspaceId) ?? null;
  const activeAccountId =
    activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;

  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeOrganizationLabel(orgs, activeAccountId);
  const canCreateOrganization =
    context.clientConfig.auth.mode === "managedSession" &&
    canCreateAdditionalOrganization({
      managedUserId: context.authSession?.user.id ?? null,
      emailVerified: context.authSession?.user.emailVerified === true,
      selfContext: context.managedSelfContext,
    });
  const [createOpen, setCreateOpen] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("General");
  const [createBusy, setCreateBusy] = useState(false);
  const operationId = useRef<string | null>(null);

  function updateCreateOpen(open: boolean) {
    if (createBusy && !open) return;
    setCreateOpen(open);
    if (!open) {
      setOrganizationName("");
      setWorkspaceName("General");
      operationId.current = null;
    }
  }

  async function submitCreateOrganization() {
    const name = organizationName.trim();
    const initialWorkspaceName = workspaceName.trim();
    if (!name || !initialWorkspaceName || createBusy) return;
    operationId.current ??= crypto.randomUUID();
    setCreateBusy(true);
    try {
      const created = await context.client.createAdditionalOrganization({
        name,
        workspaceName: initialWorkspaceName,
        operationId: operationId.current,
      });
      const refreshed = await context.refreshPrincipalAccess();
      if (!refreshed) {
        throw new Error("Your access changed before the new organization could be opened");
      }
      toast.success(`${created.organization.name} created`, {
        description: `${initialWorkspaceName} is ready for your team.`,
      });
      setCreateBusy(false);
      setCreateOpen(false);
      setOrganizationName("");
      setWorkspaceName("General");
      operationId.current = null;
      rail.openWorkspace(created.workspaceId);
    } catch (error) {
      toast.error("Failed to create organization", {
        description: error instanceof Error ? error.message : String(error),
      });
      setCreateBusy(false);
    }
  }

  if (rail.collapsed) {
    return (
      <>
        <WorkspaceSwitcherMenu
          workspaceId={rail.workspaceId}
          collapsed
          align="start"
          onSelect={rail.openWorkspace}
          onCreateOrganization={canCreateOrganization ? () => setCreateOpen(true) : undefined}
        />
        {createOpen ? (
          <Suspense fallback={null}>
            <LazyCreateOrganizationDialog
              open
              organizationName={organizationName}
              workspaceName={workspaceName}
              busy={createBusy}
              onOrganizationNameChange={setOrganizationName}
              onWorkspaceNameChange={setWorkspaceName}
              onOpenChange={updateCreateOpen}
              onSubmit={() => void submitCreateOrganization()}
            />
          </Suspense>
        ) : null}
      </>
    );
  }

  return (
    <div className={WORKSPACE_SWITCHER_GRID_CLASS}>
      <OrganizationSwitcherLine
        orgs={orgs}
        currentLabel={currentOrgLabel}
        activeAccountId={activeAccountId}
        onSelect={rail.openOrg}
        onCreate={canCreateOrganization ? () => setCreateOpen(true) : undefined}
        workspaceId={rail.workspaceId}
      />
      {createOpen ? (
        <Suspense fallback={null}>
          <LazyCreateOrganizationDialog
            open
            organizationName={organizationName}
            workspaceName={workspaceName}
            busy={createBusy}
            onOrganizationNameChange={setOrganizationName}
            onWorkspaceNameChange={setWorkspaceName}
            onOpenChange={updateCreateOpen}
            onSubmit={() => void submitCreateOrganization()}
          />
        </Suspense>
      ) : null}

      <WorkspaceSwitcherMenu
        workspaceId={rail.workspaceId}
        collapsed={false}
        align="start"
        onSelect={rail.openWorkspace}
      />
    </div>
  );
}

export function OrganizationSwitcherLine(props: {
  orgs: OrgOption[];
  currentLabel: string;
  activeAccountId: string | null;
  onSelect: (accountId: string) => void;
  onCreate?: () => void;
  workspaceId: string | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${props.currentLabel}. Organization menu`}
          className="flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5 text-2xs font-medium text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline-none"
        >
          <BuildingIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{props.currentLabel}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {props.orgs.length > 1 ? (
          <>
            <DropdownMenuLabel className="text-fg-subtle">Organizations</DropdownMenuLabel>
            {props.orgs.map((org) => (
              <DropdownMenuItem
                key={org.accountId}
                aria-current={org.accountId === props.activeAccountId ? "true" : undefined}
                onSelect={() => {
                  if (org.accountId !== props.activeAccountId) {
                    props.onSelect(org.accountId);
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 items-center justify-center rounded bg-surface-3 text-2xs font-semibold"
                >
                  {org.label
                    .replace(/^Org\s+/, "")
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{org.label}</span>
                {org.accountId === props.activeAccountId ? (
                  <CheckIcon aria-hidden="true" className="size-4 text-brand" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <DropdownMenuLabel className="text-fg-subtle">{props.currentLabel}</DropdownMenuLabel>
        )}
        {props.onCreate ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                props.onCreate?.();
              }}
            >
              <PlusIcon className="size-4" />
              New organization…
            </DropdownMenuItem>
          </>
        ) : null}
        {props.workspaceId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId: props.workspaceId }}
              >
                <SettingsIcon className="size-4" />
                Organization settings
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
