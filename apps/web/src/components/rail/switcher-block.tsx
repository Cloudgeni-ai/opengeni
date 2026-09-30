// The rail's workspace picker. Its trigger names the workspace and its
// organization; its menu lists the current organization's workspaces and, for
// a person in several organizations, the others to switch to. Collapsed, it
// reduces to a workspace-initial avatar that opens the same menu. Creating an
// organization lives in the account menu (`useCreateOrganizationFlow`).
import { Link } from "@tanstack/react-router";
import { OpenGeniApiError } from "@opengeni/sdk";
import { BuildingIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { useRail } from "@/components/rail/rail-context";
import { WorkspaceSwitcherMenu } from "@/components/rail/workspace-switcher";
import { userErrorText } from "@/lib/api-error";
import type { OrgOption } from "@/lib/org";
import { canCreateAdditionalOrganization } from "@/lib/managed-self-context";

const LazyCreateOrganizationDialog = lazy(() =>
  import("@/components/rail/create-organization-dialog").then((module) => ({
    default: module.CreateOrganizationDialog,
  })),
);

type AdditionalOrganizationCreationState = "draft" | "uncertain" | "committed";

export function additionalOrganizationCreationOutcomeUnknown(error: unknown): boolean {
  return error instanceof OpenGeniApiError ? error.outcomeUnknown : error instanceof TypeError;
}

export function additionalOrganizationCreationAttemptIsCurrent(input: {
  acceptedRevision: number;
  currentRevision: number;
  ownerUserId: string;
  currentManagedUserId: string | null;
  operationOwnerUserId: string | null;
}): boolean {
  return (
    input.acceptedRevision === input.currentRevision &&
    input.ownerUserId === input.currentManagedUserId &&
    input.ownerUserId === input.operationOwnerUserId
  );
}

export const WORKSPACE_SWITCHER_GRID_CLASS = "grid min-w-0 grid-cols-[minmax(0,1fr)] px-2";

/**
 * The "New organization" flow: eligibility, the dialog and its exact-once
 * creation state. `onCreated` opens the new organization's first workspace.
 */
export function useCreateOrganizationFlow(onCreated: (workspaceId: string) => void): {
  canCreate: boolean;
  start: () => void;
  dialog: ReactNode;
} {
  const context = useAppContext();
  const managedUserId = context.authSession?.user.id ?? null;
  const canCreateOrganization =
    context.clientConfig.auth.mode === "managedSession" &&
    canCreateAdditionalOrganization({
      managedUserId,
      emailVerified: context.authSession?.user.emailVerified === true,
      selfContext: context.managedSelfContext,
    });
  const [createOpen, setCreateOpen] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("General");
  const [createBusy, setCreateBusy] = useState(false);
  const [creationState, setCreationState] = useState<AdditionalOrganizationCreationState>("draft");
  const operationId = useRef<string | null>(null);
  const operationOwnerUserId = useRef<string | null>(null);
  const currentManagedUserId = useRef(managedUserId);
  const creationAttemptRevision = useRef(0);
  currentManagedUserId.current = managedUserId;

  function resetCreateOrganizationDraft() {
    setOrganizationName("");
    setWorkspaceName("General");
    setCreationState("draft");
    operationId.current = null;
    operationOwnerUserId.current = null;
  }

  useEffect(() => {
    if (operationOwnerUserId.current !== null && operationOwnerUserId.current !== managedUserId) {
      creationAttemptRevision.current += 1;
      setCreateBusy(false);
      setCreateOpen(false);
      resetCreateOrganizationDraft();
    }
  }, [managedUserId]);

  useEffect(
    () => () => {
      creationAttemptRevision.current += 1;
    },
    [],
  );

  function updateCreateOpen(open: boolean) {
    if (createBusy && !open) return;
    setCreateOpen(open);
    if (!open && creationState === "draft") {
      resetCreateOrganizationDraft();
    }
  }

  async function submitCreateOrganization() {
    const name = organizationName.trim();
    const initialWorkspaceName = workspaceName.trim();
    if (!name || !initialWorkspaceName || !managedUserId || createBusy) return;
    if (operationOwnerUserId.current !== null && operationOwnerUserId.current !== managedUserId) {
      return;
    }
    if (!operationId.current) {
      operationId.current = crypto.randomUUID();
      operationOwnerUserId.current = managedUserId;
    }
    const acceptedAttemptRevision = ++creationAttemptRevision.current;
    const attemptIsCurrent = () =>
      additionalOrganizationCreationAttemptIsCurrent({
        acceptedRevision: acceptedAttemptRevision,
        currentRevision: creationAttemptRevision.current,
        ownerUserId: managedUserId,
        currentManagedUserId: currentManagedUserId.current,
        operationOwnerUserId: operationOwnerUserId.current,
      });
    setCreateBusy(true);
    let attemptedState: AdditionalOrganizationCreationState = creationState;
    if (attemptedState === "draft") {
      attemptedState = "uncertain";
      setCreationState("uncertain");
    }
    try {
      const created = await context.client.createAdditionalOrganization({
        name,
        workspaceName: initialWorkspaceName,
        operationId: operationId.current,
      });
      if (!attemptIsCurrent()) return;
      attemptedState = "committed";
      setCreationState("committed");
      const refreshed = await context.refreshPrincipalAccess();
      if (!attemptIsCurrent()) return;
      if (!refreshed) {
        throw new Error("Your access changed before the new organization could be opened");
      }
      onCreated(created.workspaceId);
      toast.success(`${created.organization.name} created`, {
        description: `${initialWorkspaceName} is ready for your team.`,
      });
      setCreateBusy(false);
      setCreateOpen(false);
      resetCreateOrganizationDraft();
    } catch (error) {
      if (!attemptIsCurrent()) return;
      const outcomeUnknown = additionalOrganizationCreationOutcomeUnknown(error);
      if (attemptedState !== "committed" && !outcomeUnknown) {
        attemptedState = "draft";
        setCreationState("draft");
        operationId.current = null;
        operationOwnerUserId.current = null;
      }
      toast.error(
        attemptedState === "committed"
          ? "Organization created, but not opened"
          : attemptedState === "uncertain"
            ? "Creation could not be confirmed"
            : "Couldn't create the organization",
        {
          description:
            attemptedState === "committed"
              ? "Try again to refresh access and open the same organization."
              : attemptedState === "uncertain"
                ? "Try again to safely replay this exact request and confirm the result."
                : userErrorText(error),
        },
      );
    } finally {
      if (attemptIsCurrent()) setCreateBusy(false);
    }
  }

  return {
    canCreate: canCreateOrganization,
    start: () => setCreateOpen(true),
    dialog: createOpen ? (
      <Suspense fallback={null}>
        <LazyCreateOrganizationDialog
          open
          organizationName={organizationName}
          workspaceName={workspaceName}
          busy={createBusy}
          creationState={creationState}
          onOrganizationNameChange={setOrganizationName}
          onWorkspaceNameChange={setWorkspaceName}
          onOpenChange={updateCreateOpen}
          onSubmit={() => void submitCreateOrganization()}
        />
      </Suspense>
    ) : null,
  };
}

/**
 * "New organization" for the account menu: the menu item (null when this
 * person can't create one) and the dialog, which the caller renders outside
 * the menu so it outlives it.
 */
export function useNewOrganizationMenuItem(): { item: ReactNode; dialog: ReactNode } {
  const rail = useRail();
  const flow = useCreateOrganizationFlow(rail.openWorkspace);
  return {
    item: flow.canCreate ? (
      <DropdownMenuItem onSelect={flow.start}>
        <PlusIcon />
        New organization
      </DropdownMenuItem>
    ) : null,
    dialog: flow.dialog,
  };
}

export function SwitcherBlock({ inline = false }: { inline?: boolean }) {
  const rail = useRail();

  if (rail.collapsed) {
    return (
      <WorkspaceSwitcherMenu
        workspaceId={rail.workspaceId}
        collapsed
        align="start"
        onSelect={rail.openWorkspace}
      />
    );
  }

  return (
    <div className={inline ? "ml-auto grid min-w-0 flex-1" : WORKSPACE_SWITCHER_GRID_CLASS}>
      <WorkspaceSwitcherMenu
        workspaceId={rail.workspaceId}
        collapsed={false}
        compact={inline}
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
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
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
                  className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-2xs font-semibold text-fg-muted"
                >
                  {org.label
                    .replace(/^Org\s+/, "")
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{org.label}</span>
                <DropdownMenuCheck checked={org.accountId === props.activeAccountId} />
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <DropdownMenuLabel>{props.currentLabel}</DropdownMenuLabel>
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
              <PlusIcon />
              New organization
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
                <SettingsIcon />
                Organization settings
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
