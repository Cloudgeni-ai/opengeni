/**
 * Kit-only app frame for page previews: the proposed main rail (240px), a
 * phone top bar under 840px of frame width, the page column, and overlays
 * (sheets and dialogs) contained inside the frame so a preview reads like a
 * browser window. Built from the real NavItem, NavGroup, ContentPage and
 * ScopeSwitcherTrigger primitives.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  BotIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  GaugeIcon,
  InboxIcon,
  MenuIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { firstFormField } from "@/components/ui/form-dialog";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { NavGroup, NavItem, type NavItemSize } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

import { chats, currentWorkspace, organization, you } from "../../fixtures";

/* ----------------------------------------------------------------------------
   Overlay host: overlays portal into the frame, and the page behind them goes
   inert (no focus, no clicks) while any is open.
   -------------------------------------------------------------------------- */

interface FrameContextValue {
  host: HTMLElement | null;
  register: () => () => void;
}

const FrameContext = createContext<FrameContextValue | null>(null);

function useFrame(): FrameContextValue {
  const frame = useContext(FrameContext);
  if (!frame) throw new Error("Frame overlays must render inside <AppFrame>.");
  return frame;
}

/* ----------------------------------------------------------------------------
   Rail.
   -------------------------------------------------------------------------- */

interface Destination {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  attention?: boolean;
}

const RAIL: Destination[] = [
  { id: "new-session", label: "New session", icon: SquarePenIcon },
  { id: "for-you", label: "For you", icon: InboxIcon, badge: "2" },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "schedules", label: "Schedules", icon: CalendarClockIcon },
  { id: "artifacts", label: "Artifacts", icon: PanelsTopLeftIcon },
  { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon, attention: true },
  { id: "capabilities", label: "Capabilities", icon: PlugIcon },
  { id: "insights", label: "Insights", icon: GaugeIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function prevent(event: { preventDefault: () => void }) {
  event.preventDefault();
}

function WorkspaceSwitcher() {
  return (
    <ScopeSwitcherTrigger
      label={currentWorkspace.name}
      icon={currentWorkspace.name.charAt(0)}
      className="w-full"
    />
  );
}

function AccountRow() {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-1">
      <Avatar size="sm">
        <AvatarFallback className="bg-surface-3 text-2xs font-semibold text-fg-muted">
          {you.initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm leading-5 font-medium text-fg">{you.name}</p>
        <p className="truncate text-2xs text-fg-subtle">Owner · {organization.name}</p>
      </div>
    </div>
  );
}

export function MainRail({
  active,
  itemSize,
  onNavigate,
  className,
}: {
  active: string;
  itemSize?: NavItemSize;
  /** The Schedules item returns to the list. */
  onNavigate?: (id: string) => void;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex h-full w-60 shrink-0 flex-col border-r border-border bg-bg px-3",
        className,
      )}
    >
      <div className="pt-3">
        <WorkspaceSwitcher />
      </div>
      <nav aria-label="Main" className="mt-4">
        <NavGroup>
          {RAIL.map((item) => {
            const Icon = item.icon;
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
                attention={item.attention}
                attentionLabel="3 waiting for review"
                active={active === item.id}
                size={itemSize}
              />
            );
          })}
        </NavGroup>
      </nav>
      <div className="mt-6 min-h-0">
        <NavGroup label="Chats">
          {chats.map((chat) => (
            <NavItem key={chat.id} href={`#${chat.id}`} onClick={prevent} label={chat.title} />
          ))}
        </NavGroup>
      </div>
      <div className="mt-auto border-t border-border py-3">
        <AccountRow />
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------------------------
   The frame.
   -------------------------------------------------------------------------- */

export function AppFrame({
  active = "schedules",
  itemSize,
  onNavigate,
  children,
}: {
  active?: string;
  itemSize?: NavItemSize;
  onNavigate?: (id: string) => void;
  /** The page. Rendered inside ContentPage (the standard 960px column). */
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const register = useCallback(() => {
    setOpenCount((count) => count + 1);
    return () => setOpenCount((count) => count - 1);
  }, []);
  const value = useMemo(() => ({ host, register }), [host, register]);

  return (
    <FrameContext.Provider value={value}>
      <div className="@container/frame relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg text-fg">
        <div inert={openCount > 0} className="flex h-full min-h-0 w-full min-w-0 flex-1">
          <MainRail
            active={active}
            itemSize={itemSize}
            onNavigate={onNavigate}
            // Frames under 840px wide use the phone layout: a top bar and a rail sheet.
            className="hidden @[840px]/frame:flex"
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 @[840px]/frame:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Open navigation"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(true)}
                className="text-fg-muted hover:text-fg pointer-coarse:size-11"
              >
                <MenuIcon />
              </Button>
              <span className="min-w-0 truncate text-sm font-medium text-fg">
                {currentWorkspace.name}
              </span>
            </header>
            <ContentPage width="standard" className="pt-6 pb-16">
              {children}
            </ContentPage>
          </div>
        </div>
        <div ref={setHost} className="contents" />
        <FrameOverlay
          open={navOpen}
          onClose={() => setNavOpen(false)}
          side="left"
          label="Navigation"
        >
          <div className="relative h-full">
            <MainRail
              active={active}
              itemSize={itemSize}
              onNavigate={(id) => {
                setNavOpen(false);
                onNavigate?.(id);
              }}
              className="w-[280px] border-r-0"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close navigation"
              onClick={() => setNavOpen(false)}
              className="absolute top-3.5 -right-11 text-brand-fg hover:bg-transparent hover:text-brand-fg pointer-coarse:size-11"
            >
              <XIcon />
            </Button>
          </div>
        </FrameOverlay>
      </div>
    </FrameContext.Provider>
  );
}

/* ----------------------------------------------------------------------------
   FrameOverlay: a sheet or dialog inside the frame.
   -------------------------------------------------------------------------- */

export type FrameOverlaySide = "right" | "left" | "center";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside the panel, like a modal: the last stop wraps to the first. */
function trapTab(event: KeyboardEvent<HTMLDivElement>, panel: HTMLElement | null) {
  if (!panel) return;
  const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
  );
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function FrameOverlay({
  open,
  onClose,
  side = "right",
  width = 520,
  label,
  labelledBy,
  focus = "panel",
  autoFocus = true,
  dismissOnScrim = true,
  blockClose = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: FrameOverlaySide;
  /** Panel width in px (right sheets). Phones get the full width. */
  width?: number;
  /** Accessible name, unless `labelledBy` points at a visible title. */
  label?: string;
  labelledBy?: string;
  /** What gets focus on open: the panel (or its `data-autofocus` element), or the first form field. */
  focus?: "panel" | "field";
  /** Off for overlays that are open when the preview first renders. */
  autoFocus?: boolean;
  /** A scrim click closes it (forms pass false once something was typed). */
  dismissOnScrim?: boolean;
  /** Saving: Escape and the scrim do nothing. */
  blockClose?: boolean;
  children: ReactNode;
}) {
  const { host, register } = useFrame();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    return register();
  }, [open, register]);

  // Remember what had focus (the row, the menu's button), move focus in, and
  // give it back on close.
  useLayoutEffect(() => {
    if (!open) return;
    setDirty(false);
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    const menu = returnTo.current?.closest<HTMLElement>('[role="menu"]');
    const menuButtonId = menu?.getAttribute("aria-labelledby");
    if (menuButtonId) returnTo.current = document.getElementById(menuButtonId);
    return () => {
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) {
        requestAnimationFrame(() => {
          if (target.isConnected && !target.closest("[inert]"))
            target.focus({ preventScroll: true });
        });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        focus === "field"
          ? firstFormField(panel.querySelector('[data-slot="form-body"]') ?? panel)
          : panel.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? panel).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, focus, open]);

  if (!open || !host) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapTab(event, panelRef.current);
      return;
    }
    if (event.key !== "Escape" || event.defaultPrevented || blockClose) return;
    event.stopPropagation();
    onClose();
  };

  const center = side === "center";
  return createPortal(
    <div className="absolute inset-0 z-40 flex" onKeyDown={onKeyDown}>
      <div
        aria-hidden="true"
        onClick={() => {
          if (!blockClose && dismissOnScrim && !dirty) onClose();
        }}
        className="absolute inset-0 bg-black/50 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onInput={() => setDirty(true)}
        style={side === "right" ? { width: `min(100%, ${width}px)` } : undefined}
        className={cn(
          "relative z-10 flex min-h-0 min-w-0 flex-col outline-none",
          side === "right" &&
            "ml-auto h-full border-l border-border bg-surface shadow-[var(--og-shadow-lg)] transition-transform duration-200 ease-out starting:translate-x-full motion-reduce:transition-none",
          side === "left" &&
            "mr-auto h-full bg-bg shadow-[var(--og-shadow-lg)] transition-transform duration-200 ease-out starting:-translate-x-full motion-reduce:transition-none",
          center &&
            "mx-auto w-full max-w-[480px] self-end transition-opacity duration-[120ms] starting:opacity-0 motion-reduce:transition-none @[640px]/frame:mt-24 @[640px]/frame:self-start",
        )}
      >
        {children}
      </div>
    </div>,
    host,
  );
}
