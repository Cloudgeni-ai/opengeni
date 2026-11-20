// The rail's customizable part (docs/sidebar-layout.md): the workspace's
// default links and groups, with each person's own changes on top. Phones
// show groups flattened and live lists shortened; the icon rail leaves it out.
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ResolvedSidebarChild, ResolvedSidebarItem, SidebarLayoutChange } from "@opengeni/sdk";
import { flattenSidebarItemsForMobile } from "@opengeni/contracts/sidebar-layout";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { cn } from "@opengeni/react/app/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { appPageLocation, appPagePathname } from "./app-page-location";
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

function RowMenu({ item, actions }: { item: ResolvedSidebarItem; actions: RowActions }) {
  const navigate = useNavigate();
  const rail = useRail();
  const index = actions.siblings.indexOf(item.id);
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
      <DropdownMenuContent align="start" side="right" className="min-w-44">
        {actions.canChange ? (
          <>
            <DropdownMenuItem
              disabled={index <= 0}
              onSelect={() => actions.change([{ op: "move", itemId: item.id, index: index - 1 }])}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index < 0 || index >= actions.siblings.length - 1}
              onSelect={() => actions.change([{ op: "move", itemId: item.id, index: index + 1 }])}
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
  if (item.type === "link")
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
  // A live list: its label, then its apps. An empty list keeps its label so
  // it can be found again once it fills.
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

export function SidebarLayoutSection() {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { layout, update } = useSidebarLayout(rail.workspaceId);
  const [openGroups, setOpenGroups] = useState(readOpenGroups);
  if (rail.collapsed || !layout || layout.items.length === 0) return null;
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
    const items = flattenSidebarItemsForMobile(layout.items);
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
  const rootIds = layout.items.map((item) => item.id);
  return (
    <nav aria-label="Workspace links" className="mt-2 grid gap-0.5 px-2" data-sidebar-layout>
      {layout.items.map((item) => {
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
            child.type === "app" &&
            pathname.startsWith(appPagePathname(rail.workspaceId, child.appId)),
        );
        const open = holdsActive || (openGroups[item.id] ?? !item.collapsed);
        const childIds = item.items.map((child) => child.id);
        return (
          <div key={item.id} className="grid gap-0.5">
            <div className="group/row relative">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(item.id, !open)}
                className={cn(ROW, "w-full pr-8 text-left")}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
              <RowMenu item={item} actions={actions} />
            </div>
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
    </nav>
  );
}
