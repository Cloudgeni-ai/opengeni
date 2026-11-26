// The rail's customizable part (docs/sidebar-layout.md): the workspace's
// default links and groups, with each person's own changes on top. Phones
// show groups flattened and live lists shortened; the icon rail leaves it out.
// It's edited in place: a group's "+" adds an app, each row's menu renames,
// sets the icon or a list's size, and hides or removes it, and rows drag to
// another place (an app dragged from the Sessions list is added where it's
// dropped). A quiet Customize row under it opens the Sidebar page.
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ResolvedSidebarChild, ResolvedSidebarItem, SidebarLayoutChange } from "@opengeni/sdk";
import {
  flattenSidebarItemsForMobile,
  SIDEBAR_LABEL_MAX_CHARS,
  sidebarItemsShown,
} from "@opengeni/contracts/sidebar-layout";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  readSiteRowDragPayload,
  SITE_DRAG_TYPE,
} from "@opengeni/react/app/components/rail/site-session-group-heading";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";
import { cn } from "@opengeni/react/app/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { pathHasAppPage } from "@/lib/onboarding-return";
import { appPageLocation, appPagePathname, appRowActive } from "./app-page-location";
import { MoveToGroupMenu, type SidebarGroupChoice } from "./group-menu";
import { inAppLinkPath } from "./in-app-link";
import { IconMenu, SidebarIcon, useLinkIcon } from "./sidebar-icons";
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

/** A quiet button at a row's right end, shown while the pointer is over the row. */
const ROW_BUTTON =
  "absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100";

/** A sidebar item being dragged to another place. */
const ITEM_DRAG_TYPE = "application/x-opengeni-sidebar-item";

type DraggedItem = { id: string; parentId: string | null; origin: string; type: string };

const LIST_SIZES = [3, 5, 10, 20] as const;

type RowActions = {
  change: (changes: SidebarLayoutChange[]) => void;
  canChange: boolean;
  /** The item whose name is being edited in place. */
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  /** The rows just before and after an item at its level, for Move up and Move down. */
  neighbors?: (id: string) => { previous?: string; next?: string };
  /** The groups shown, for Move to group. */
  groups?: readonly SidebarGroupChoice[];
  /** An item's group, or null at the top level. */
  parentOf?: (id: string) => string | null;
  /**
   * Archive an app from this person's sidebar, as its row in the Sessions
   * list does. Its link stays saved and shows again once it's restored.
   */
  archive?: ((appId: string, label: string) => void) | undefined;
};

/** Whether this person edits the item itself (their own), rather than hiding it. */
function editable(item: ResolvedSidebarItem, actions: RowActions): boolean {
  return actions.canChange && item.origin === "personal";
}

function RowMenu({ item, actions }: { item: ResolvedSidebarItem; actions: RowActions }) {
  const navigate = useNavigate();
  const rail = useRail();
  const own = editable(item, actions);
  const hasIcon = item.type === "app" || item.type === "link" || item.type === "group";
  const near = actions.neighbors?.(item.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${item.label}`}
          className={cn(ROW_BUTTON, "right-1")}
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
          if (actions.renaming === item.id) event.preventDefault();
        }}
      >
        {own ? (
          <DropdownMenuItem onSelect={() => actions.setRenaming(item.id)}>Rename</DropdownMenuItem>
        ) : null}
        {own && hasIcon ? (
          <IconMenu
            value={"icon" in item ? item.icon : undefined}
            onSelect={(icon) => actions.change([{ op: "update", itemId: item.id, icon }])}
          />
        ) : null}
        {own && item.type === "live_list" ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Show</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-28">
              {LIST_SIZES.map((size) => (
                <DropdownMenuItem
                  key={size}
                  aria-current={item.limit === size ? "true" : undefined}
                  onSelect={() => actions.change([{ op: "update", itemId: item.id, limit: size }])}
                >
                  <span className="flex-1">{size} apps</span>
                  <DropdownMenuCheck checked={item.limit === size} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {own && item.type !== "group" && actions.groups && actions.parentOf ? (
          <MoveToGroupMenu
            groups={actions.groups}
            current={actions.parentOf(item.id)}
            onSelect={(groupId) => actions.change([{ op: "move", itemId: item.id, groupId }])}
          />
        ) : null}
        {actions.canChange && near?.previous ? (
          <DropdownMenuItem
            onSelect={() =>
              actions.change([{ op: "move", itemId: item.id, beforeId: near.previous! }])
            }
          >
            Move up
          </DropdownMenuItem>
        ) : null}
        {actions.canChange && near?.next ? (
          <DropdownMenuItem
            onSelect={() => actions.change([{ op: "move", itemId: item.id, afterId: near.next! }])}
          >
            Move down
          </DropdownMenuItem>
        ) : null}
        {actions.canChange ? (
          <DropdownMenuItem onSelect={() => actions.change([{ op: "remove", itemId: item.id }])}>
            {item.type === "app" ? "Unpin" : item.origin === "workspace" ? "Hide" : "Remove"}
          </DropdownMenuItem>
        ) : null}
        {item.type === "app" && actions.archive ? (
          <DropdownMenuItem onSelect={() => actions.archive?.(item.appId, item.label)}>
            Archive
          </DropdownMenuItem>
        ) : null}
        {actions.canChange || (item.type === "app" && actions.archive) ? (
          <DropdownMenuSeparator />
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

/** An item's name, edited in place: Enter or leaving the field saves, Escape cancels. */
function RenameRow({
  item,
  actions,
  indent,
}: {
  item: ResolvedSidebarItem;
  actions: RowActions;
  indent?: boolean | undefined;
}) {
  const [value, setValue] = useState(item.label);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  // The menu that opened it hands focus back to its button as it closes; take it after that.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    if (next && next !== item.label)
      actions.change([{ op: "update", itemId: item.id, label: next }]);
    actions.setRenaming(null);
  };
  return (
    <div className={cn("flex h-8 items-center px-1 pointer-coarse:h-10", indent && "pl-3")}>
      <input
        ref={input}
        aria-label="Name"
        value={value}
        maxLength={SIDEBAR_LABEL_MAX_CHARS}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(value.trim())}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(value.trim());
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          }
        }}
        className="h-7 w-full min-w-0 rounded-md border border-border-strong bg-surface px-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/** Apps to add, by title; the newest first until the person types. */
function useAppSearch(workspaceId: string, query: string, enabled: boolean) {
  const { client } = useAppContext();
  const [apps, setApps] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void client
        .listArtifactCatalog(workspaceId, {
          kind: "site",
          status: "active",
          sort: "updated",
          limit: 8,
          ...(query.trim() ? { q: query.trim() } : {}),
          signal: abort.signal,
        })
        .then((page) => setApps(page.items.map((app) => ({ id: app.id, title: app.title }))))
        .catch(() => undefined);
    }, 150);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [client, enabled, query, workspaceId]);
  return apps;
}

/** "+" on a group: add an app to it. */
function AddAppButton({ group, actions }: { group: ResolvedSidebarItem; actions: RowActions }) {
  const rail = useRail();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const apps = useAppSearch(rail.workspaceId, query, open);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Add an app to ${group.label}`}
          className={cn(ROW_BUTTON, "right-7")}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-60">
        <input
          aria-label="Search apps"
          placeholder="Search apps"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          // Typing searches; the menu's own type-ahead would jump between items.
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
          }}
          className="mb-1 h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-ring"
        />
        {apps.map((app) => (
          <DropdownMenuItem
            key={app.id}
            onSelect={() =>
              actions.change([
                { op: "add", item: { type: "app", appId: app.id }, groupId: group.id },
              ])
            }
          >
            <AppWindowIcon aria-hidden="true" className="size-4" />
            <span className="min-w-0 flex-1 truncate">{app.title}</span>
          </DropdownMenuItem>
        ))}
        {apps.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-fg-muted">No apps found</div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The change a drop makes: a sidebar item moves before or after `target`
 * (into its level when it's the person's own), or into the group `target`
 * when dropped on a group's name; an app dragged from the Sessions list is
 * added there.
 */
function dropChange(
  data: DataTransfer,
  target: ResolvedSidebarItem,
  parentId: string | null,
  at: "before" | "after" | "into",
): SidebarLayoutChange | null {
  const raw = data.getData(ITEM_DRAG_TYPE);
  const place = at === "before" ? { beforeId: target.id } : { afterId: target.id };
  if (raw) {
    let dragged: DraggedItem;
    try {
      dragged = JSON.parse(raw) as DraggedItem;
    } catch {
      return null;
    }
    if (dragged.id === target.id) return null;
    if (at === "into") {
      // Groups don't nest.
      if (
        dragged.parentId === target.id ||
        dragged.origin !== "personal" ||
        dragged.type === "group"
      )
        return null;
      return { op: "move", itemId: dragged.id, groupId: target.id };
    }
    if (dragged.parentId === parentId) return { op: "move", itemId: dragged.id, ...place };
    // Default items stay in the group the admin put them in; groups don't nest.
    if (dragged.origin !== "personal" || (dragged.type === "group" && parentId !== null))
      return null;
    return { op: "move", itemId: dragged.id, groupId: parentId, ...place };
  }
  const site = readSiteRowDragPayload(data.getData(SITE_DRAG_TYPE));
  if (!site) return null;
  const item = { type: "app" as const, appId: site.siteId };
  if (at === "into") return { op: "add", item, groupId: target.id };
  return { op: "add", item, ...(parentId ? { groupId: parentId } : {}), ...place };
}

/** A row that can be dragged to another place, and dropped on. */
function DragRow({
  item,
  parentId,
  actions,
  group,
  children,
}: {
  item: ResolvedSidebarItem;
  parentId: string | null;
  actions: RowActions;
  /** A group's name: the middle of it drops into the group. */
  group?: boolean;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState<"before" | "after" | "into" | null>(null);
  if (!actions.canChange) return <>{children}</>;
  const zone = (event: React.DragEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - box.top) / Math.max(box.height, 1);
    if (group && y > 0.25 && y < 0.75) return "into" as const;
    return y < 0.5 ? ("before" as const) : ("after" as const);
  };
  const accepts = (event: React.DragEvent<HTMLDivElement>) =>
    event.dataTransfer.types.includes(ITEM_DRAG_TYPE) ||
    event.dataTransfer.types.includes(SITE_DRAG_TYPE);
  return (
    <div
      className="relative"
      draggable={actions.renaming !== item.id}
      onDragStart={(event) => {
        event.stopPropagation();
        const dragged: DraggedItem = {
          id: item.id,
          parentId,
          origin: item.origin,
          type: item.type,
        };
        event.dataTransfer.setData(ITEM_DRAG_TYPE, JSON.stringify(dragged));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(zone(event));
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        const change = dropChange(event.dataTransfer, item, parentId, zone(event));
        if (change) actions.change([change]);
      }}
      data-drop={over ?? undefined}
    >
      {over === "before" || over === "after" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-brand",
            over === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      {over === "into" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-md ring-2 ring-brand"
        />
      ) : null}
      {children}
    </div>
  );
}

function AppRow({
  workspaceId,
  appId,
  path,
  label,
  icon,
  pathname,
  menu,
  indent,
}: {
  workspaceId: string;
  appId: string;
  path: string | null;
  label: string;
  icon?: string | undefined;
  pathname: string;
  menu?: React.ReactNode;
  indent?: boolean | undefined;
}) {
  const rail = useRail();
  const location = appPageLocation(path);
  const active = appRowActive(pathname, workspaceId, appId, location.splat);
  return (
    <div className="relative">
      <Link
        to="/workspaces/$workspaceId/apps/$appId/$"
        params={{ workspaceId, appId, _splat: location.splat }}
        search={location.at ? { at: location.at } : {}}
        data-active={active ? "true" : undefined}
        className={cn(ROW, menu && "pr-8", indent && "pl-4")}
        onClick={() => rail.setDrawerOpen(false)}
        draggable={false}
      >
        <SidebarIcon name={icon} fallback={AppWindowIcon} />
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
  indent?: boolean | undefined;
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
        draggable={false}
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

/** An outside link: its own icon, else its site's, else an arrow. Opens in a new tab. */
function ExternalLinkRow({
  item,
  workspaceId,
  menu,
  indent,
}: {
  item: Extract<ResolvedSidebarChild, { type: "link" }>;
  workspaceId: string;
  menu: React.ReactNode;
  indent?: boolean | undefined;
}) {
  const siteIcon = useLinkIcon(workspaceId, item.url, !item.icon);
  return (
    <div className="relative">
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(ROW, "pr-8", indent && "pl-4")}
        title={item.url}
        draggable={false}
      >
        {item.icon || !siteIcon ? (
          <SidebarIcon name={item.icon} fallback={ArrowUpRightIcon} />
        ) : (
          <img alt="" src={siteIcon} className="size-4 shrink-0 rounded-sm object-contain" />
        )}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      {menu}
    </div>
  );
}

function ChildRows({
  item,
  parentId,
  workspaceId,
  pathname,
  actions,
  indent,
}: {
  item: ResolvedSidebarChild;
  parentId: string | null;
  workspaceId: string;
  pathname: string;
  actions: RowActions;
  indent?: boolean;
}) {
  const router = useRouter();
  if (actions.renaming === item.id)
    return <RenameRow item={item} actions={actions} indent={indent} />;
  const menu = <RowMenu item={item} actions={actions} />;
  let row: React.ReactNode;
  if (item.type === "app")
    row = (
      <AppRow
        workspaceId={workspaceId}
        appId={item.appId}
        path={item.path}
        label={item.label}
        icon={item.icon}
        pathname={pathname}
        menu={menu}
        indent={indent}
      />
    );
  else if (item.type === "agent")
    row = (
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
  else if (item.type === "link") {
    const inApp = inAppLinkPath(item.url, window.location.origin, (path) =>
      pathHasAppPage(router, path),
    );
    row =
      inApp !== null ? (
        <InAppLinkRow
          path={inApp}
          label={item.label}
          icon={item.icon}
          pathname={pathname}
          menu={menu}
          indent={indent}
        />
      ) : (
        <ExternalLinkRow item={item} workspaceId={workspaceId} menu={menu} indent={indent} />
      );
  } else
    // A live list: its label, then its apps. An empty list isn't shown (see
    // sidebarItemsShown); the Sidebar page still lists it.
    row = (
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
  return (
    <DragRow item={item} parentId={parentId} actions={actions}>
      {row}
    </DragRow>
  );
}

/** A link to a page of this Opengeni: opens in place, like the rail's own links. */
function InAppLinkRow({
  path,
  label,
  icon,
  pathname,
  menu,
  indent,
}: {
  path: string;
  label: string;
  icon?: string | undefined;
  pathname: string;
  menu: React.ReactNode;
  indent?: boolean | undefined;
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
        draggable={false}
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
        <SidebarIcon name={icon} fallback={LinkIcon} />
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

/**
 * Apps just archived from the sidebar on this page. Their links leave the
 * layout the server returns, so the Sessions list's Apps section counts them as
 * still in the sidebar until its own read shows them archived (never both
 * places). Each entry lasts only that long, or until the app's link is back.
 */
export const appsArchivedFromSidebar = new Set<string>();
const ARCHIVED_BRIDGE_MS = 30_000;

/**
 * Archive for app rows: the same personal sidebar archive as the app's row in
 * the Sessions list, so it leaves both places. Absent where the client
 * predates it.
 */
export function useSidebarAppArchive(
  workspaceId: string,
  reload: () => void,
): RowActions["archive"] {
  const { client } = useAppContext();
  if (typeof client.updateSiteSidebarState !== "function") return undefined;
  const run = (appId: string, label: string, archived: boolean): void => {
    if (archived) {
      const key = appId.toLowerCase();
      appsArchivedFromSidebar.add(key);
      setTimeout(() => appsArchivedFromSidebar.delete(key), ARCHIVED_BRIDGE_MS);
    }
    void client
      .updateSiteSidebarState(workspaceId, appId, { archived })
      .then(() => {
        if (!archived) appsArchivedFromSidebar.delete(appId.toLowerCase());
        reload();
        toast.success(archived ? "App archived" : "App restored", {
          ...(archived
            ? {
                description: "Hidden from your sidebar only.",
                duration: 8000,
                action: { label: "Undo", onClick: () => run(appId, label, false) },
              }
            : {}),
        });
      })
      .catch((error: unknown) => {
        if (archived) appsArchivedFromSidebar.delete(appId.toLowerCase());
        toast.error(archived ? `Couldn't archive ${label}.` : `Couldn't restore ${label}.`, {
          description: userErrorText(error),
        });
      });
  };
  return (appId, label) => run(appId, label, true);
}

export function SidebarLayoutSection() {
  const rail = useRail();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { layout, update, reload } = useSidebarLayout(rail.workspaceId);
  const archive = useSidebarAppArchive(rail.workspaceId, reload);
  const [openGroups, setOpenGroups] = useState(readOpenGroups);
  // Groups closed while they hold the open page, until the page changes: such
  // a group opens by itself, as before, and the person can still close it.
  const [closedHere, setClosedHere] = useState<{ path: string; ids: ReadonlySet<string> }>({
    path: "",
    ids: new Set(),
  });
  useEffect(() => {
    setClosedHere((current) =>
      current.path === pathname ? current : { path: pathname, ids: new Set() },
    );
  }, [pathname]);
  const [renaming, setRenaming] = useState<string | null>(null);
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
    const actions: RowActions = {
      change,
      canChange: false,
      renaming: null,
      setRenaming,
      archive,
    };
    return (
      <nav aria-label="Workspace links" className="mt-2 grid gap-0.5 px-2" data-sidebar-layout>
        {items.map((item) => (
          <ChildRows
            key={item.id}
            item={item}
            parentId={null}
            workspaceId={rail.workspaceId}
            pathname={pathname}
            actions={actions}
          />
        ))}
      </nav>
    );
  }
  const neighbors = (id: string) => {
    const levels = [
      shownItems,
      ...shownItems.flatMap((each) => (each.type === "group" ? [each.items] : [])),
    ];
    for (const level of levels) {
      const index = level.findIndex((each) => each.id === id);
      if (index >= 0) return { previous: level[index - 1]?.id, next: level[index + 1]?.id };
    }
    return {};
  };
  const groups = shownItems.flatMap((each) =>
    each.type === "group" ? [{ id: each.id, label: each.label }] : [],
  );
  const parentOf = (id: string) =>
    shownItems.find((each) => each.type === "group" && each.items.some((child) => child.id === id))
      ?.id ?? null;
  const actions: RowActions = {
    change,
    canChange,
    renaming,
    setRenaming,
    neighbors,
    groups,
    parentOf,
    archive,
  };
  return (
    <nav
      aria-label="Workspace links"
      className="group/layout mt-2 grid gap-0.5 px-2"
      data-sidebar-layout
    >
      {shownItems.map((item) => {
        if (item.type !== "group")
          return (
            <ChildRows
              key={item.id}
              item={item}
              parentId={null}
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
        const open = holdsActive
          ? !(closedHere.path === pathname && closedHere.ids.has(item.id))
          : (openGroups[item.id] ?? !item.collapsed);
        return (
          <div key={item.id} className="grid gap-0.5">
            {renaming === item.id ? (
              <RenameRow item={item} actions={actions} />
            ) : (
              <DragRow item={item} parentId={null} actions={actions} group>
                <div className="group/row relative">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      if (!holdsActive) return toggle(item.id, !open);
                      const ids = new Set(closedHere.path === pathname ? closedHere.ids : []);
                      if (open) ids.add(item.id);
                      else ids.delete(item.id);
                      setClosedHere({ path: pathname, ids });
                    }}
                    className={cn(ROW, "w-full text-left", canChange ? "pr-14" : "pr-8")}
                  >
                    {item.icon ? (
                      <SidebarIcon name={item.icon} fallback={ChevronRightIcon} />
                    ) : (
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.icon ? (
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5 shrink-0 text-fg-subtle transition-[transform,opacity] group-hover/row:opacity-0",
                          open && "rotate-90",
                        )}
                      />
                    ) : null}
                  </button>
                  {canChange ? <AddAppButton group={item} actions={actions} /> : null}
                  <RowMenu item={item} actions={actions} />
                </div>
              </DragRow>
            )}
            {open
              ? item.items.map((child) => (
                  <ChildRows
                    key={child.id}
                    item={child}
                    parentId={item.id}
                    workspaceId={rail.workspaceId}
                    pathname={pathname}
                    actions={actions}
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
