// The Opengeni Console frame: a 240px rail (organization, then Overview,
// Build and Organization pages), a header bar and one content column. No chat
// rail: Console is for the organization's owners and admins.
import { Link, Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  BotIcon,
  Building2Icon,
  ChevronsUpDownIcon,
  CreditCardIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  MessagesSquareIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import { BrandMark } from "@opengeni/react/app/components/brand-mark";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  organizationLandingWorkspaceId,
  organizationsForSubject,
} from "@opengeni/react/app/lib/org";
import {
  readLastWorkspaceId,
  workspaceNavigationPreferenceStorageId,
} from "@opengeni/react/app/lib/workspace-navigation-preference";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { Button } from "@opengeni/react/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { ScopeSwitcherTrigger } from "@opengeni/react/ui/scope-switcher-trigger";
import { NavGroup, NavItem } from "@opengeni/react/ui/settings-nav";
import { Sheet, SheetContent, SheetTitle } from "@opengeni/react/ui/sheet";

import { CONSOLE_PATH, onConsoleHost, type ConsoleSearch } from "@/lib/console-route";
import {
  ConsoleContext,
  ConsoleForbidden,
  useConsoleSignOut,
  type ConsoleContextValue,
} from "./console-shared";

type ConsoleDestination =
  | "/console"
  | "/console/sessions"
  | "/console/agents"
  | "/console/workspaces"
  | "/console/api-keys"
  | "/console/members"
  | "/console/usage"
  | "/console/settings";

type NavEntry = { to: ConsoleDestination; label: string; icon: ReactNode };

const NAV: { group: string | null; items: NavEntry[] }[] = [
  { group: null, items: [{ to: "/console", label: "Overview", icon: <LayoutDashboardIcon /> }] },
  {
    group: "Build",
    items: [
      { to: "/console/sessions", label: "Sessions", icon: <MessagesSquareIcon /> },
      { to: "/console/agents", label: "Agents", icon: <BotIcon /> },
      { to: "/console/workspaces", label: "Workspaces", icon: <Building2Icon /> },
      { to: "/console/api-keys", label: "API keys", icon: <KeyRoundIcon /> },
    ],
  },
  {
    group: "Organization",
    items: [
      { to: "/console/members", label: "Members", icon: <UsersIcon /> },
      { to: "/console/usage", label: "Usage and billing", icon: <CreditCardIcon /> },
      { to: "/console/settings", label: "Settings", icon: <SettingsIcon /> },
    ],
  },
];

/** The nav entry a path belongs to: its longest matching prefix. */
export function consoleNavDestination(pathname: string): ConsoleDestination {
  const path = pathname.replace(/\/+$/u, "") || CONSOLE_PATH;
  let best: ConsoleDestination = "/console";
  for (const entry of NAV.flatMap((group) => group.items)) {
    if (entry.to !== "/console" && (path === entry.to || path.startsWith(`${entry.to}/`))) {
      best = entry.to;
    }
  }
  return best;
}

function initial(label: string): string {
  return (label.replace(/^Org\s+/u, "").trim()[0] ?? "O").toUpperCase();
}

/** Who is signed in, and Sign out. On a Console host nothing here leads into the app. */
function ConsoleAccountMenu({ label, role }: { label: string; role: string | null }) {
  const context = useAppContext();
  const signOut = useConsoleSignOut();
  if (!label && !signOut) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`${label || "Account"}. Account menu`}
        >
          <span className="min-w-0 flex-1 truncate" title={label}>
            {label}
            {role ? ` · ${role}` : ""}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        {context.authSession?.user.email ? (
          <DropdownMenuLabel className="truncate">
            {context.authSession.user.email}
          </DropdownMenuLabel>
        ) : null}
        {signOut ? (
          <DropdownMenuItem variant="destructive" onSelect={signOut}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ConsoleShellRoute() {
  const context = useAppContext();
  const navigate = useNavigate();
  const { org: requestedOrg } = useSearch({ strict: false }) as ConsoleSearch;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);
  const consoleHost = onConsoleHost();

  const orgs = useMemo(() => {
    const all = organizationsForSubject(t, context.accessContext, context.workspaces);
    return all.map((org) => ({
      ...org,
      canAdminister:
        org.canManage ||
        administersOrganization({
          accessContext: context.accessContext,
          clientConfig: context.clientConfig,
          accountId: org.accountId,
        }),
    }));
  }, [context.accessContext, context.clientConfig, context.workspaces]);

  const rememberedWorkspaceId = readLastWorkspaceId(
    workspaceNavigationPreferenceStorageId(context.accessContext.subjectId),
  );
  const rememberedAccountId =
    context.workspaces.find((workspace) => workspace.id === rememberedWorkspaceId)?.accountId ??
    null;
  const administered = orgs.filter((org) => org.canAdminister);
  const organization =
    orgs.find((org) => org.accountId === requestedOrg) ??
    administered.find((org) => org.accountId === rememberedAccountId) ??
    administered[0] ??
    orgs[0] ??
    null;

  const value = useMemo<ConsoleContextValue | null>(
    () =>
      organization
        ? {
            client: context.client,
            organizationId: organization.accountId,
            organizationLabel: organization.label,
            search: { org: organization.accountId },
            appWorkspaceId: organizationLandingWorkspaceId(
              context.workspaces,
              organization.accountId,
              rememberedWorkspaceId,
            ),
          }
        : null,
    [context.client, context.workspaces, organization, rememberedWorkspaceId],
  );

  const active = consoleNavDestination(pathname);
  const switchable = administered.length > 0 ? administered : orgs;
  const displayName =
    context.authSession?.user.name ||
    context.authSession?.user.email ||
    context.accessContext.subjectLabel ||
    "";
  const role = organization
    ? context.accessContext.accountGrants.find(
        (grant) =>
          grant.accountId === organization.accountId &&
          grant.subjectId === context.accessContext.subjectId,
      )?.role
    : undefined;

  const sidebar = (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg px-3">
      <div className="flex items-center gap-2 px-2 pt-4 pb-3">
        <BrandMark className="w-5 text-brand" />
        <span className="text-sm font-semibold">Opengeni Console</span>
      </div>
      {organization ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ScopeSwitcherTrigger
              label={organization.label}
              meta="Organization"
              icon={initial(organization.label)}
              className="w-full"
              aria-label={`${organization.label}. Switch organization`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {switchable.map((org) => (
              <DropdownMenuItem
                key={org.accountId}
                aria-current={org.accountId === organization.accountId ? "true" : undefined}
                onSelect={() => {
                  setMenuOpen(false);
                  if (org.accountId === organization.accountId) return;
                  void navigate({ to: active, search: { org: org.accountId } });
                }}
              >
                <span className="min-w-0 flex-1 truncate">{org.label}</span>
                <DropdownMenuCheck checked={org.accountId === organization.accountId} />
              </DropdownMenuItem>
            ))}
            {value ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/console/settings" search={value.search}>
                    Rename organization
                  </Link>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <nav aria-label="Console" className="mt-3 flex w-full flex-col gap-3 overflow-y-auto">
        {NAV.map((section) => (
          <NavGroup key={section.group ?? "main"} label={section.group ?? undefined}>
            {section.items.map((item) => (
              <NavItem
                key={item.to}
                asChild
                icon={item.icon}
                label={item.label}
                active={active === item.to}
              >
                <Link
                  to={item.to}
                  search={value ? value.search : {}}
                  onClick={() => setMenuOpen(false)}
                />
              </NavItem>
            ))}
          </NavGroup>
        ))}
      </nav>
      <div className="mt-auto w-full border-t border-border py-2">
        <ConsoleAccountMenu
          label={displayName}
          role={role === "owner" ? "Owner" : role === "admin" ? "Admin" : null}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-bg text-fg">
      <aside className="hidden h-full w-60 shrink-0 border-r border-border md:block">
        {sidebar}
      </aside>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Console menu</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon aria-hidden="true" />
          </Button>
          <span className="truncate text-sm font-medium md:hidden">Opengeni Console</span>
          <div className="ml-auto flex items-center gap-1">
            {context.clientConfig.documentationUrl ? (
              <Button variant="ghost" size="sm" asChild>
                <a href={context.clientConfig.documentationUrl} target="_blank" rel="noreferrer">
                  <BookOpenIcon aria-hidden="true" />
                  Docs
                </a>
              </Button>
            ) : null}
            {consoleHost ? null : (
              <Button variant="ghost" size="sm" asChild>
                {value?.appWorkspaceId ? (
                  <Link
                    to="/workspaces/$workspaceId/sessions"
                    params={{ workspaceId: value.appWorkspaceId }}
                  >
                    <ArrowUpRightIcon aria-hidden="true" />
                    Open Opengeni
                  </Link>
                ) : (
                  <Link to="/">
                    <ArrowUpRightIcon aria-hidden="true" />
                    Open Opengeni
                  </Link>
                )}
              </Button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <main
            aria-label="Console page"
            className="mx-auto w-full max-w-[1000px] px-4 pt-8 pb-16 md:px-8"
          >
            {value && organization?.canAdminister ? (
              <ConsoleContext.Provider value={value}>
                <Outlet />
              </ConsoleContext.Provider>
            ) : (
              <ConsoleForbidden />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
