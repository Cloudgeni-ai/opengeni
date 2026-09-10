import { ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  accountMenuAriaLabel,
  OrganizationInvitationCountBadge,
  OrganizationInvitationRailNotice,
  OrganizationInvitationsDialog,
  OrganizationInvitationsMenuItem,
  type OrganizationInvitationsController,
} from "../src/components/organization-invitations";
import { Avatar, AvatarFallback } from "../src/components/ui/avatar";
import { Button } from "../src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../src/components/ui/tooltip";
import { AppearanceProvider, useAppearance } from "../src/lib/appearance";
import type { OrganizationInvitation } from "../src/types";
import "../src/styles.css";

const displayName = "Ada Lovelace";
const secondary = "ada@example.test";

function invitation(input: {
  id: string;
  organizationId: string;
  organizationName: string | null;
}): OrganizationInvitation {
  return {
    id: input.id,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    targetEmail: secondary,
    targetName: displayName,
    initialWorkspaceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    role: "member",
    status: "pending",
    revision: 1,
    expiresAt: "2026-10-08T12:00:00.000Z",
    acceptedMembershipId: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    delivery: null,
  };
}

const northwindInvite = invitation({
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Northwind",
});

const atlasInvite = invitation({
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: "44444444-4444-4444-8444-444444444444",
  organizationName: "Atlas Research",
});

function useFixtureController(
  invitations: OrganizationInvitation[],
  initialOpen = false,
): OrganizationInvitationsController {
  const [open, setOpen] = useState(initialOpen);
  return useMemo(
    () => ({
      open,
      invitations,
      pendingCount: invitations.length,
      loaded: true,
      loading: false,
      error: null,
      acceptingInvitationId: null,
      announcement: "",
      continuation: null,
      canUseInvitedAccount: false,
      openDialog: () => setOpen(true),
      setOpen,
      useInvitedAccount: () => undefined,
      reload: async () => undefined,
      accept: async () => undefined,
    }),
    [invitations, open],
  );
}

function RailAccountFooter(props: {
  collapsed: boolean;
  controller: OrganizationInvitationsController;
  onToggleCollapsed: () => void;
}) {
  const { collapsed, controller } = props;
  return (
    <div className="mt-auto border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className={collapsed ? "grid justify-items-center gap-1" : "flex items-end gap-1.5"}>
        <div className={collapsed ? undefined : "min-w-0 flex-1"}>
          {!collapsed ? <OrganizationInvitationRailNotice controller={controller} /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={accountMenuAriaLabel({
                  displayName,
                  pendingCount: controller.pendingCount,
                })}
                className="flex min-h-11 min-w-0 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2"
              >
                <span className="relative shrink-0">
                  <Avatar size="sm">
                    <AvatarFallback className="bg-surface-3 text-2xs text-fg-muted">
                      A
                    </AvatarFallback>
                  </Avatar>
                  <OrganizationInvitationCountBadge pendingCount={controller.pendingCount} />
                </span>
                {!collapsed ? (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-fg">
                      {displayName}
                    </span>
                    <span className="block truncate text-2xs text-fg-subtle">{secondary}</span>
                  </span>
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side={collapsed ? "right" : "top"}
              className="w-[min(18rem,calc(100vw-1rem))]"
            >
              <DropdownMenuLabel className="grid gap-0.5">
                <span className="truncate text-sm">{displayName}</span>
                <span className="truncate text-xs font-normal text-fg-subtle">{secondary}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <OrganizationInvitationsMenuItem controller={controller} />
              <DropdownMenuItem disabled>Appearance</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={props.onToggleCollapsed}
              className="shrink-0 text-fg-subtle hover:text-fg"
            >
              {collapsed ? (
                <ChevronsRightIcon className="size-4" />
              ) : (
                <ChevronsLeftIcon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
      <OrganizationInvitationsDialog controller={controller} />
    </div>
  );
}

function ForceDark(props: { children: ReactNode }) {
  const { setAppearance } = useAppearance();
  useEffect(() => {
    setAppearance("dark");
  }, [setAppearance]);
  return props.children;
}

function OrganizationInvitationChromeFixture() {
  const [collapsed, setCollapsed] = useState(false);
  const [inviteCount, setInviteCount] = useState<1 | 2>(1);
  const invitations = inviteCount === 1 ? [northwindInvite] : [northwindInvite, atlasInvite];
  const controller = useFixtureController(invitations);

  return (
    <AppearanceProvider>
      <ForceDark>
        <TooltipProvider delayDuration={300}>
          <main className="flex h-screen bg-background text-foreground">
            <aside
              data-testid="session-sidebar"
              className={`flex h-full flex-col border-r border-border bg-surface ${collapsed ? "w-16" : "w-64"}`}
              aria-label="Session sidebar"
            >
              <div className="border-b border-border px-3 py-3 text-sm font-medium text-fg">
                {collapsed ? "OG" : "OpenGeni"}
              </div>
              <div className="flex-1 px-3 py-3 text-xs text-fg-muted">
                {collapsed ? null : "Sessions"}
              </div>
              <RailAccountFooter
                collapsed={collapsed}
                controller={controller}
                onToggleCollapsed={() => setCollapsed((value) => !value)}
              />
            </aside>
            <section className="flex-1 p-8">
              <h1 className="text-xl font-medium">Pending organization invitation</h1>
              <p className="mt-2 max-w-xl text-sm text-fg-muted">
                The tinted notice and avatar count sit on the account footer. They open the existing
                invitations dialog without first opening the account menu.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={inviteCount === 1 ? "default" : "secondary"}
                  onClick={() => {
                    setInviteCount(1);
                    setCollapsed(false);
                  }}
                >
                  One invitation
                </Button>
                <Button
                  type="button"
                  variant={inviteCount === 2 ? "default" : "secondary"}
                  onClick={() => {
                    setInviteCount(2);
                    setCollapsed(false);
                  }}
                >
                  Two invitations
                </Button>
                <Button type="button" variant="secondary" onClick={() => setCollapsed(true)}>
                  Collapse sidebar
                </Button>
                <Button type="button" variant="secondary" onClick={() => controller.openDialog()}>
                  Open invitations dialog
                </Button>
              </div>
            </section>
          </main>
        </TooltipProvider>
      </ForceDark>
    </AppearanceProvider>
  );
}

createRoot(document.getElementById("root")!).render(<OrganizationInvitationChromeFixture />);
