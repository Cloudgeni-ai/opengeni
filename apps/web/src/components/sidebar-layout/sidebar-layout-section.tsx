// The rail's customizable part (docs/sidebar-layout.md): the workspace's
// default links and groups, with each person's own changes on top. Phones
// show groups flattened and live lists shortened; the icon rail leaves it out.
// A quiet Customize row under it opens the Sidebar page.
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  LinkIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ResolvedSidebarChild, ResolvedSidebarItem, SidebarLayoutChange } from "@opengeni/sdk";
import {
  flattenSidebarItemsForMobile,
  sidebarItemsShown,
} from "@opengeni/contracts/sidebar-layout";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import { cn } from "@opengeni/react/app/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { pathHasAppPage } from "@/lib/onboarding-return";
import { appPageLocation, appPagePathname } from "./app-page-location";
import { inAppLinkPath } from "./in-app-link";
import { RenameField } from "./rename-field";
import { useSidebarLayout } from "./use-sidebar-layout";

const GROUPS_OPEN_KEY = "opengeni.rail.sidebar-groups";

function readOpenGroups(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(GROUPS_OPEN_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const ROW =
  "group/row relative flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm font-normal text-fg-label transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-10 data-[active=true]:bg-selection data-[active=true]:text-fg";

type RowActions = {
  /** The level's ids in order, for Move up/down. */
  siblings: string[];
  change: (changes: SidebarLayoutChange[]) => void;
  canChange: boolean;
};

function RowMenu({
  item,
  actions,
  onRename,
}: {
  item: ResolvedSidebarItem;
  actions: RowActions;
  /** Your own group's Rename; the default's groups are renamed on the Sidebar page. */
  onRename?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const rail = useRail();
  const [renaming, setRenaming] = useState(false);
  const index = actions.siblings.indexOf(item.id);
  // Moves name the visible neighbour: the stored level may hold items this
  // person doesn't see, so an index could land elsewhere.
  const previous = index > 0 ? actions.siblings[index - 1] : undefined;
  const following = index >= 0 ? actions.siblings[index + 1] : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${item.label}`}
          className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="min-w-44"
        onCloseAutoFocus={(event) => {
          // Rename focuses its field instead.
          if (renaming) {
            event.preventDefault();
            setRenaming(false);
          }
        }}
      >
        {actions.canChange ? (
          <>
            {onRename ? (
              <DropdownMenuItem
                onSelect={() => {
                  setRenaming(true);
                  onRename();
                }}
              >
                Rename
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={previous === undefined}
              onSelect={() => actions.change([{ op: "move", itemId: item.id, beforeId: previous }])}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={following === undefined}
              onSelect={() => actions.change([{ op: "move", itemId: item.id, afterId: following }])}
            >
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.change([{ op: "remove", itemId: item.id }])}>
              {item.origin === "workspace" ? "Hide" : "Remove"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            rail.setDrawerOpen(false);
            void navigate({
              to: "/workspaces/$workspaceId/sidebar",
              params: { workspaceId: rail.workspaceId },
            });
          }}
        >
          Customize sidebar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppRow({
  workspaceId,
  appId,
  path,
  label,
  pathname,
  menu,
  indent,
}: {
  workspaceId: string;
  appId: string;
  path: string | null;
  label: string;
  pathname: string;
  menu?: React.ReactNode;
  indent?: boolean;
}) {
  const rail = useRail();
  const location = appPageLocation(path);
  const active = pathname === appPagePathname(workspaceId, appId, location.splat);
  return (
    <div className="relative">
      <Link
        to="/workspaces/$workspaceId/apps/$appId/$"
        params={{ workspaceId, appId, _splat: location.splat }}
        search={location.at ? { at: location.at } : {}}
        data-active={active ? "true" : undefined}
        className={cn(ROW, menu && "pr-8", indent && "pl-4")}
        onClick={() => rail.setDrawerOpen(false)}
      >
        <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
      {menu}
    </div>
  );
}

/** An agent's page, with its avatar; opens in place. */
function AgentRow({
  workspaceId,
  agentId,
  avatar,
  label,
  pathname,
  menu,
  indent,
}: {
  workspaceId: string;
  agentId: string;
  avatar: Extract<ResolvedSidebarChild, { type: "agent" }>["avatar"];
  label: string;
  pathname: string;
  menu?: React.ReactNode;
  indent?: boolean;
}) {
  const rail = useRail();
  const active = pathname.startsWith(agentPagePathname(workspaceId, agentId));
  return (
    <div className="relative">
      <Link
        to="/workspaces/$workspaceId/agents/$agentId"
        params={{ workspaceId, agentId }}
        data-active={active ? "true" : undefined}
        className={cn(ROW, menu && "pr-8", indent && "pl-4")}
        onClick={() => rail.setDrawerOpen(false)}
      >
        <SessionAvatar
          avatar={avatar}
          name={label}
          workspaceId={workspaceId}
          seed={agentId}
          size="xs"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
      {menu}
    </div>
  );
}

/** An agent page's path, without a trailing slash. */
export function agentPagePathname(workspaceId: string, agentId: string): string {
  return `/workspaces/${workspaceId}/agents/${agentId}`;
}

function ChildRows({
  item,
  workspaceId,
  pathname,
  actions,
  indent,
}: {
  item: ResolvedSidebarChild;
  workspaceId: string;
  pathname: string;
  actions: RowActions;
  indent?: boolean;
}) {
  const router = useRouter();
  const menu = <RowMenu item={item} actions={actions} />;
  if (item.type === "app")
    return (
      <AppRow
        workspaceId={workspaceId}
        appId={item.appId}
        path={item.path}
        label={item.label}
        pathname={pathname}
        menu={menu}
        indent={indent}
      />
    );
  if (item.type === "agent")
    return (
      <AgentRow
        workspaceId={workspaceId}
        agentId={item.agentId}
        avatar={item.avatar}
        label={item.label}
        pathname={pathname}
        menu={menu}
        indent={indent}
      />
    );
  if (item.type === "link") {
    const inApp = inAppLinkPath(item.url, window.location.origin, (path) =>
      pathHasAppPage(router, path),
    );
    if (inApp !== null)
      return (
        <InAppLinkRow
          path={inApp}
          label={item.label}
          pathname={pathname}
          menu={menu}
          indent={indent}
        />
      );
    return (
      <div className="relative">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(ROW, "pr-8", indent && "pl-4")}
          title={item.url}
        >
          <ArrowUpRightIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        {menu}
      </div>
    );
  }
  // A live list: its label, then its apps. An empty list isn't shown (see
  // sidebarItemsShown); the Sidebar page still lists it.
  return (
    <div className="grid gap-0.5">
      <div className="group/row relative">
        <div
          className={cn(
            "flex h-7 items-center px-2.5 text-xs font-medium text-fg-subtle",
            indent && "pl-4",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </div>
        {menu}
      </div>
      {item.apps.map((app) => (
        <AppRow
          key={app.appId}
          workspaceId={workspaceId}
          appId={app.appId}
          path={null}
          label={app.title}
          pathname={pathname}
          indent={indent}
        />
      ))}
    </div>
  );
}

/** A link to a page of this Opengeni: opens in place, like the rail's own links. */
function InAppLinkRow({
  path,
  label,
  pathname,
  menu,
  indent,
}: {
  path: string;
  label: string;
  pathname: string;
  menu: React.ReactNode;
  indent?: boolean;
}) {
  const router = useRouter();
  const rail = useRail();
  const active = pathname === new URL(path, window.location.origin).pathname;
  return (
    <div className="relative">
      <a
        href={path}
        data-active={active ? "true" : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(ROW, "pr-8", indent && "pl-4")}
        onClick={(event) => {
          // Let the browser open a new tab or window when asked to.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          rail.setDrawerOpen(false);
          router.history.push(path);
        }}
      >
        <LinkIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </a>
      {menu}
    </div>
  );
}

/**
 * Opens the Sidebar page from the section itself: quiet until the pointer is
 * over the section (always shown on touch screens and to the keyboard).
 */
export function CustomizeRow() {
  const navigate = useNavigate();
  const rail = useRail();
  return (
    <button
      type="button"
      onClick={() => {
        rail.setDrawerOpen(false);
        void navigate({
          to: "/workspaces/$workspaceId/sidebar",
          params: { workspaceId: rail.workspaceId },
        });
      }}
      className="flex h-6 items-center self-start rounded-md px-2.5 text-xs text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/layout:opacity-100 group-focus-within/layout:opacity-100 pointer-coarse:opacity-100"
    >
      Customize
    </button>
  );
}

/** A group's row: opens and closes it, and your own group renames in place. */
export function GroupRow({
  item,
  open,
  onToggle,
  actions,
}: {
  item: ResolvedSidebarItem;
  open: boolean;
  onToggle: () => void;
  actions: RowActions;
}) {
  const [renaming, setRenaming] = useState(false);
  if (renaming)
    return (
      <div className="px-0.5 py-0.5">
        <RenameField
          label={item.label}
          onSave={(label) => actions.change([{ op: "update", itemId: item.id, label }])}
          onDone={() => setRenaming(false)}
        />
      </div>
    );
  return (
    <div className="group/row relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(ROW, "w-full pr-8 text-left")}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
      <RowMenu
        item={item}
        actions={actions}
        onRename={item.origin === "workspace" ? undefined : () => setRenaming(true)}
      />
    </div>
  );
}

export function SidebarLayoutSection() {
  const rail = useRail();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { layout, update } = useSidebarLayout(rail.workspaceId);
  const [openGroups, setOpenGroups] = useState(readOpenGroups);
  const shownItems = layout ? sidebarItemsShown(layout.items) : [];
  if (rail.collapsed || !layout || shownItems.length === 0) return null;
  const canChange = layout.personal.available;
  const change = (changes: SidebarLayoutChange[]) =>
    void update({ scope: "personal", changes }).catch((error: unknown) =>
      toast.error("Couldn't change the sidebar", { description: userErrorText(error) }),
    );
  const toggle = (id: string, open: boolean) => {
    const next = { ...openGroups, [id]: open };
    setOpenGroups(next);
    try {
      window.localStorage.setItem(GROUPS_OPEN_KEY, JSON.stringify(next));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };
  if (rail.isMobile) {
    const items = flattenSidebarItemsForMobile(shownItems);
    const actions: RowActions = { siblings: [], change, canChange: false };
    return (
      <nav aria-label="Workspace links" className="mt-2 grid gap-0.5 px-2" data-sidebar-layout>
        {items.map((item) => (
          <ChildRows
            key={item.id}
            item={item}
            workspaceId={rail.workspaceId}
            pathname={pathname}
            actions={actions}
          />
        ))}
      </nav>
    );
  }
  const rootIds = shownItems.map((item) => item.id);
  return (
    <nav
      aria-label="Workspace links"
      className="group/layout mt-2 grid gap-0.5 px-2"
      data-sidebar-layout
    >
      {shownItems.map((item) => {
        const actions: RowActions = { siblings: rootIds, change, canChange };
        if (item.type !== "group")
          return (
            <ChildRows
              key={item.id}
              item={item}
              workspaceId={rail.workspaceId}
              pathname={pathname}
              actions={actions}
            />
          );
        const holdsActive = item.items.some(
          (child) =>
            (child.type === "app" &&
              pathname.startsWith(appPagePathname(rail.workspaceId, child.appId))) ||
            (child.type === "agent" &&
              pathname.startsWith(agentPagePathname(rail.workspaceId, child.agentId))) ||
            (child.type === "link" &&
              inAppLinkPath(child.url, window.location.origin, (path) =>
                pathHasAppPage(router, path),
              )?.split(/[?#]/)[0] === pathname),
        );
        const open = holdsActive || (openGroups[item.id] ?? !item.collapsed);
        const childIds = item.items.map((child) => child.id);
        return (
          <div key={item.id} className="grid gap-0.5">
            <GroupRow
              item={item}
              open={open}
              onToggle={() => toggle(item.id, !open)}
              actions={actions}
            />
            {open
              ? item.items.map((child) => (
                  <ChildRows
                    key={child.id}
                    item={child}
                    workspaceId={rail.workspaceId}
                    pathname={pathname}
                    actions={{ siblings: childIds, change, canChange }}
                    indent
                  />
                ))
              : null}
          </div>
        );
      })}
      {canChange || layout.workspace.canEdit ? <CustomizeRow /> : null}
    </nav>
  );
}
