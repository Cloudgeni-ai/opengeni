import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  BotIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  GaugeIcon,
  InboxIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  SettingsIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { NavGroup, NavItem } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

import { chats, organization, you } from "../../fixtures";
import { PagePreview, useKitPane } from "../../kit";

/* ----------------------------------------------------------------------------
   The app window the page previews sit in: the proposed main rail (every
   destination once, one name, one icon) and a scrolling content area.

   The frame responds to its own width, like the app responds to the window:
   - 1200px and up: the 240px rail.
   - 640-1199px: the collapsed icon rail (the kit column is ~1136px wide at a
     1440px window, so this is what a laptop-sized preview shows). The rail
     button expands it to 240px.
   - Under 640px: a top bar whose menu opens the rail as a sheet.
   -------------------------------------------------------------------------- */

export type RailId =
  | "new-session"
  | "for-you"
  | "agents"
  | "schedules"
  | "artifacts"
  | "knowledge"
  | "capabilities"
  | "insights"
  | "settings";

interface RailDestination {
  id: RailId;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const RAIL: RailDestination[] = [
  { id: "new-session", label: "New session", icon: SquarePenIcon },
  { id: "for-you", label: "For you", icon: InboxIcon, badge: "2" },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "schedules", label: "Schedules", icon: CalendarClockIcon },
  { id: "artifacts", label: "Artifacts", icon: PanelsTopLeftIcon },
  { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon },
  { id: "capabilities", label: "Capabilities", icon: PlugIcon },
  { id: "insights", label: "Insights", icon: GaugeIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

/** The icon a rail destination uses, so page headers match their rail entry. */
export function railIcon(id: RailId): LucideIcon {
  return RAIL.find((item) => item.id === id)?.icon ?? SettingsIcon;
}

/** Width of an element, measured before paint and kept in sync. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function prevent(event: MouseEvent) {
  event.preventDefault();
}

type RailMode = "full" | "collapsed";

export interface MainRailProps {
  active: RailId;
  workspaceName: string;
  mode?: RailMode;
  /** Pending reviews: a purple dot on Knowledge. */
  knowledgeAttention?: number;
  onNavigate?: (id: RailId) => void;
  /** Shows the collapse or expand button. */
  onToggleMode?: () => void;
  className?: string;
}

export function MainRail({
  active,
  workspaceName,
  mode = "full",
  knowledgeAttention = 0,
  onNavigate,
  onToggleMode,
  className,
}: MainRailProps) {
  const collapsed = mode === "collapsed";
  return (
    <aside
      data-slot="kit-main-rail"
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-bg",
        collapsed ? "w-14 items-center px-2" : "w-60 px-3",
        className,
      )}
    >
      <div className="w-full pt-3">
        {collapsed ? (
          <span
            aria-label={`Workspace: ${workspaceName}`}
            role="img"
            className="mx-auto grid size-8 place-items-center rounded-[10px] bg-brand-strong/15 text-xs font-semibold text-brand"
          >
            {workspaceName.charAt(0)}
          </span>
        ) : (
          <ScopeSwitcherTrigger
            label={workspaceName}
            icon={workspaceName.charAt(0)}
            className="w-full"
          />
        )}
      </div>
      <nav aria-label="Main" className="mt-3 w-full">
        <NavGroup collapsed={collapsed}>
          {RAIL.map((item) => {
            const Icon = item.icon;
            const attention = item.id === "knowledge" && knowledgeAttention > 0;
            return (
              <NavItem
                key={item.id}
                href={`#${item.id}`}
                onClick={(event) => {
                  prevent(event);
                  onNavigate?.(item.id);
                }}
                icon={<Icon />}
                label={item.label}
                badge={item.badge}
                attention={attention}
                attentionLabel={`${knowledgeAttention} waiting for review`}
                active={active === item.id}
                collapsed={collapsed}
              />
            );
          })}
        </NavGroup>
      </nav>
      {collapsed ? null : (
        <div className="mt-6 w-full min-w-0">
          <NavGroup label="Chats">
            {chats.map((chat) => (
              <NavItem key={chat.id} href={`#${chat.id}`} onClick={prevent} label={chat.title} />
            ))}
          </NavGroup>
        </div>
      )}
      <div
        className={cn(
          "mt-auto flex w-full min-w-0 items-center gap-2 border-t border-border py-3",
          collapsed && "flex-col",
        )}
      >
        <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", collapsed && "flex-none")}>
          <Avatar size="sm">
            <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
              {you.initials}
            </AvatarFallback>
          </Avatar>
          {collapsed ? null : (
            <div className="min-w-0">
              <p className="truncate text-sm leading-5 font-medium text-fg">{you.name}</p>
              <p className="truncate text-xs leading-4 text-fg-subtle">{organization.name}</p>
            </div>
          )}
        </div>
        {onToggleMode ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleMode}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="shrink-0 rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------------------------
   The window.
   -------------------------------------------------------------------------- */

export type FrameLayout = "wide" | "medium" | "narrow";

export interface AppFrameProps {
  /** Accessible name of the preview region. */
  label: string;
  active: RailId;
  workspaceName: string;
  knowledgeAttention?: number;
  onNavigate?: (id: RailId) => void;
  /**
   * Replaces the main rail (the "cleaned settings rail" navigation pick).
   * Rendered in the same slot, so it collapses into the phone menu too.
   */
  rail?: ReactNode;
  /** Text in the phone top bar next to the menu button. */
  mobileTitle?: string;
  children: (layout: FrameLayout) => ReactNode;
}

const NARROW = 640;
const WIDE = 1200;

export function AppFrame({
  label,
  active,
  workspaceName,
  knowledgeAttention,
  onNavigate,
  rail,
  mobileTitle,
  children,
}: AppFrameProps) {
  const pane = useKitPane();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [railPreference, setRailPreference] = useState<RailMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const measured = width > 0;
  const layout: FrameLayout = !measured
    ? "wide"
    : width < NARROW
      ? "narrow"
      : width < WIDE
        ? "medium"
        : "wide";
  const railMode: RailMode = railPreference ?? (layout === "wide" ? "full" : "collapsed");
  const height = pane.mobileFrame ? 780 : 880;

  const mainRail = (mode: RailMode, inMenu = false) => (
    <MainRail
      active={active}
      workspaceName={workspaceName}
      mode={mode}
      knowledgeAttention={knowledgeAttention}
      onNavigate={(id) => {
        if (inMenu) setMenuOpen(false);
        onNavigate?.(id);
      }}
      onToggleMode={
        inMenu ? undefined : () => setRailPreference(mode === "full" ? "collapsed" : "full")
      }
      className={inMenu ? "w-full border-r-0" : undefined}
    />
  );

  return (
    <PagePreview label={label} height={height}>
      <div
        ref={ref}
        data-layout={layout}
        className="@container/app flex h-full min-h-0 min-w-0 bg-bg text-fg"
      >
        {layout === "narrow" ? null : (rail ?? mainRail(railMode))}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {layout === "narrow" ? (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
              <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <DialogPrimitive.Trigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Open menu"
                    className="size-11 rounded-[10px] text-fg-muted hover:text-fg"
                  >
                    <MenuIcon />
                  </Button>
                </DialogPrimitive.Trigger>
                <DialogPrimitive.Portal>
                  <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none" />
                  <DialogPrimitive.Content
                    aria-describedby={undefined}
                    className="fixed inset-y-0 left-0 z-50 flex w-[296px] max-w-[85vw] flex-col bg-bg shadow-[var(--og-shadow-lg)] outline-none transition-transform duration-200 ease-out starting:-translate-x-full motion-reduce:transition-none"
                  >
                    <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
                    {rail ?? mainRail("full", true)}
                  </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
              <p className="min-w-0 truncate text-sm font-medium text-fg">
                {mobileTitle ?? workspaceName}
              </p>
            </div>
          ) : null}
          <main
            data-slot="kit-app-main"
            className="@container/main min-h-0 min-w-0 flex-1 overflow-y-auto"
          >
            {children(layout)}
          </main>
        </div>
      </div>
    </PagePreview>
  );
}

/** The page column: standard 960px or wide 1136px of content, plus the page padding. */
export function ContentColumn({
  width = "standard",
  className,
  children,
}: {
  width?: "standard" | "wide" | "full";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full min-w-0 px-4 pt-6 pb-16 @[640px]/main:px-8",
        width === "standard" && "max-w-[1024px]",
        width === "wide" && "max-w-[1200px]",
        className,
      )}
    >
      {children}
    </div>
  );
}
