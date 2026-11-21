// Sidebar item icons (docs/sidebar-layout.md): the curated lucide set the
// contracts validate, an icon picker for wherever items are edited, and the
// site icon an outside link without one of its own falls back to.
import {
  AppWindowIcon,
  BookmarkIcon,
  BookOpenIcon,
  BotIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ClockIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  FlagIcon,
  FlaskConicalIcon,
  FolderIcon,
  GitPullRequestIcon,
  GlobeIcon,
  GraduationCapIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  InboxIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LinkIcon,
  ListChecksIcon,
  MailIcon,
  MapIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  NotebookPenIcon,
  PackageIcon,
  PenToolIcon,
  ReceiptIcon,
  RocketIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  StoreIcon,
  Table2Icon,
  TargetIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SIDEBAR_ITEM_ICONS, type SidebarItemIcon } from "@opengeni/contracts/sidebar-layout";
import { useAppContext } from "@opengeni/react/app/app-context";
import { cn } from "@opengeni/react/app/lib/utils";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@opengeni/react/ui/dropdown-menu";

export const SIDEBAR_ICON_COMPONENTS: Record<SidebarItemIcon, LucideIcon> = {
  "app-window": AppWindowIcon,
  "layout-dashboard": LayoutDashboardIcon,
  "layout-grid": LayoutGridIcon,
  "file-text": FileTextIcon,
  "book-open": BookOpenIcon,
  "notebook-pen": NotebookPenIcon,
  "chart-line": ChartLineIcon,
  "chart-column": ChartColumnIcon,
  "table-2": Table2Icon,
  "list-checks": ListChecksIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  folder: FolderIcon,
  inbox: InboxIcon,
  mail: MailIcon,
  "message-square": MessageSquareIcon,
  users: UsersIcon,
  bot: BotIcon,
  globe: GlobeIcon,
  link: LinkIcon,
  house: HouseIcon,
  store: StoreIcon,
  briefcase: BriefcaseIcon,
  receipt: ReceiptIcon,
  rocket: RocketIcon,
  star: StarIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  bookmark: BookmarkIcon,
  target: TargetIcon,
  zap: ZapIcon,
  sparkles: SparklesIcon,
  lightbulb: LightbulbIcon,
  megaphone: MegaphoneIcon,
  "shield-check": ShieldCheckIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  "git-pull-request": GitPullRequestIcon,
  bug: BugIcon,
  wrench: WrenchIcon,
  "flask-conical": FlaskConicalIcon,
  "pen-tool": PenToolIcon,
  image: ImageIcon,
  "graduation-cap": GraduationCapIcon,
  map: MapIcon,
  package: PackageIcon,
};

/** The item's own icon, or `fallback` when it has none (or one this version doesn't know). */
export function SidebarIcon({
  name,
  fallback,
  className = "size-4 shrink-0",
}: {
  name: string | undefined;
  fallback: LucideIcon;
  className?: string;
}) {
  const Icon =
    name && Object.hasOwn(SIDEBAR_ICON_COMPONENTS, name)
      ? SIDEBAR_ICON_COMPONENTS[name as SidebarItemIcon]
      : fallback;
  return <Icon aria-hidden="true" className={className} />;
}

/** "Icon" in an item's menu: the set as a grid, with None first. */
export function IconMenu({
  value,
  onSelect,
}: {
  value: string | undefined;
  onSelect: (icon: SidebarItemIcon | null) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Icon</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="grid w-60 grid-cols-6 gap-0.5 p-1.5">
        <DropdownMenuItem
          aria-label="No icon"
          onSelect={() => onSelect(null)}
          className={cn(
            "col-span-6 justify-center text-xs text-fg-muted",
            !value && "bg-selection text-fg",
          )}
        >
          None
        </DropdownMenuItem>
        {SIDEBAR_ITEM_ICONS.map((name) => {
          const Icon = SIDEBAR_ICON_COMPONENTS[name];
          return (
            <DropdownMenuItem
              key={name}
              aria-label={name.replaceAll("-", " ")}
              aria-current={value === name ? "true" : undefined}
              onSelect={() => onSelect(name)}
              className={cn("size-8 justify-center p-0", value === name && "bg-selection text-fg")}
            >
              <Icon aria-hidden="true" className="size-4" />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// Site icons by workspace and site, for the tab's lifetime: an object URL,
// null while there's none, a promise while it loads.
const linkIcons = new Map<string, string | null | Promise<string | null>>();

function siteKey(workspaceId: string, url: string): string | null {
  try {
    return `${workspaceId} ${new URL(url).origin}`;
  } catch {
    return null;
  }
}

/**
 * The site icon of an outside link, through the API (the console doesn't
 * load images from other sites). Null until it loads, and when the site has
 * none.
 */
export function useLinkIcon(workspaceId: string, url: string, enabled: boolean): string | null {
  const { client } = useAppContext();
  const key = siteKey(workspaceId, url);
  const known = key ? linkIcons.get(key) : null;
  const [icon, setIcon] = useState<string | null>(typeof known === "string" ? known : null);
  useEffect(() => {
    if (!enabled || !key) return;
    const getIcon = (client as { getSidebarLinkIcon?: typeof client.getSidebarLinkIcon })
      .getSidebarLinkIcon;
    if (typeof getIcon !== "function") return;
    let current = true;
    let entry = linkIcons.get(key);
    if (entry === undefined) {
      entry = Promise.resolve()
        .then(() => getIcon.call(client, workspaceId, url))
        .then(
          (blob) => {
            // Kept only for an answer (an icon, or none): a failed read is tried again later.
            const found = blob ? URL.createObjectURL(blob) : null;
            linkIcons.set(key, found);
            return found;
          },
          () => {
            linkIcons.delete(key);
            return null;
          },
        );
      linkIcons.set(key, entry);
    }
    void Promise.resolve(entry).then((found) => {
      if (current) setIcon(found);
    });
    return () => {
      current = false;
    };
  }, [client, enabled, key, url, workspaceId]);
  return icon;
}

/** For tests: forget the site icons. */
export function resetLinkIcons(): void {
  linkIcons.clear();
}
