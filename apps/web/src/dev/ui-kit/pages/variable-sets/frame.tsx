import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowRightIcon,
  BotIcon,
  BrainCircuitIcon,
  Building2Icon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContainerIcon,
  GaugeIcon,
  InboxIcon,
  KeyRoundIcon,
  LaptopIcon,
  MenuIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquarePenIcon,
  UsersIcon,
  VariableIcon,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

import { chats, currentWorkspace, organization, you } from "../../fixtures";
import { usePagePicks, type NavLayout } from "./answers";

/* ----------------------------------------------------------------------------
   The app around a settings page, following the Navigation pick:
   - column (A): the main rail never swaps; settings has a 200px sub-nav
     inside the content.
   - rail (B): a settings rail replaces the main rail.
   - tabs (C): settings sections as page tabs under one Settings header.

   The frame responds to its own width, like the app does to the window: an
   expanded rail when there is room, an icon rail when it is tight, and the
   phone layout (top bar, rail in a sheet, back link to Settings) under 900px.
   -------------------------------------------------------------------------- */

export type FrameMode = "wide" | "compact" | "phone";

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

const SETTINGS: Destination[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "access", label: "Access", icon: UsersIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "api-keys", label: "API keys", icon: KeyRoundIcon },
];

const RUNTIME: Destination[] = [
  { id: "variable-sets", label: "Variable sets", icon: VariableIcon },
  { id: "sandbox-environments", label: "Sandbox environments", icon: ContainerIcon },
  { id: "machines", label: "Machines", icon: LaptopIcon },
];

const ACTIVE_SETTINGS_PAGE = "variable-sets";

export interface FrameContextValue {
  mode: FrameMode;
  nav: NavLayout;
  /** The scrolling content area, for scroll-to-top and focus on page changes. */
  scrollRef: RefObject<HTMLDivElement | null>;
}

const FrameContext = createContext<FrameContextValue | null>(null);

export function useFrame(): FrameContextValue {
  const value = useContext(FrameContext);
  if (!value) throw new Error("useFrame must be used inside <AppFrame>.");
  return value;
}

function modeFor(width: number, nav: NavLayout): FrameMode {
  if (width < 900) return "phone";
  if (nav === "rail") return "wide";
  if (nav === "column") return width >= 1200 ? "wide" : "compact";
  return width >= 1000 ? "wide" : "compact";
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function linkHandler(id: string, onNavigate: (id: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(id);
  };
}

/* ----------------------------------------------------------------------------
   Rails.
   -------------------------------------------------------------------------- */

function WorkspaceSwitcher() {
  return (
    <ScopeSwitcherTrigger
      label={currentWorkspace.name}
      icon={currentWorkspace.name.charAt(0)}
      className="w-full"
      aria-label={`Workspace: ${currentWorkspace.name}. Switch workspace`}
    />
  );
}

function AccountRow({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", collapsed && "justify-center")}>
      <Avatar size="sm">
        <AvatarFallback className="text-2xs font-semibold">{you.initials}</AvatarFallback>
      </Avatar>
      {collapsed ? null : (
        <div className="min-w-0">
          <p className="truncate text-sm leading-5 font-medium text-fg">{you.name}</p>
          <p className="truncate text-xs leading-4.5 text-fg-subtle">Owner · {organization.name}</p>
        </div>
      )}
    </div>
  );
}

function MainRail({
  collapsed = false,
  onNavigate,
  className,
}: {
  collapsed?: boolean;
  onNavigate: (id: string) => void;
  className?: string;
}) {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-bg",
        collapsed ? "w-14 items-center px-2" : "w-60 px-3",
        className,
      )}
    >
      <div className="w-full pt-3">
        {collapsed ? (
          <span
            aria-label={currentWorkspace.name}
            role="img"
            className="mx-auto grid size-8 place-items-center rounded-[10px] bg-brand-strong/15 text-xs font-semibold text-brand"
          >
            {currentWorkspace.name.charAt(0)}
          </span>
        ) : (
          <WorkspaceSwitcher />
        )}
      </div>
      <nav aria-label="Main" className="mt-3 w-full">
        <NavGroup collapsed={collapsed}>
          {RAIL.map((item) => {
            const Icon = item.icon;
            return (
              <NavItem
                key={item.id}
                href={`#${item.id}`}
                onClick={linkHandler(item.id, onNavigate)}
                icon={<Icon />}
                label={item.label}
                badge={item.badge}
                attention={item.attention}
                attentionLabel="3 waiting for review"
                active={item.id === "settings"}
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
              <NavItem
                key={chat.id}
                href={`#${chat.id}`}
                onClick={linkHandler(chat.id, onNavigate)}
                label={chat.title}
              />
            ))}
          </NavGroup>
        </div>
      )}
      <div className="mt-auto w-full border-t border-border py-3">
        <AccountRow collapsed={collapsed} />
      </div>
    </aside>
  );
}

function OrganizationLink({
  onNavigate,
  comfortable = false,
}: {
  onNavigate: (id: string) => void;
  comfortable?: boolean;
}) {
  return (
    <NavGroup label="Organization">
      <NavItem
        href="#organization"
        onClick={linkHandler("organization", onNavigate)}
        label={organization.name}
        icon={<Building2Icon />}
        trailingIcon={<ArrowRightIcon />}
        size={comfortable ? "comfortable" : "default"}
      />
    </NavGroup>
  );
}

function SettingsItems({
  onNavigate,
  withIcons = false,
  comfortable = false,
  trailingIcon,
  itemClassName,
}: {
  onNavigate: (id: string) => void;
  withIcons?: boolean;
  comfortable?: boolean;
  trailingIcon?: ReactNode;
  itemClassName?: string;
}) {
  const item = (destination: Destination) => {
    const Icon = destination.icon;
    return (
      <NavItem
        key={destination.id}
        href={`#${destination.id}`}
        onClick={linkHandler(destination.id, onNavigate)}
        icon={withIcons ? <Icon /> : undefined}
        label={destination.label}
        active={destination.id === ACTIVE_SETTINGS_PAGE}
        size={comfortable ? "comfortable" : "default"}
        trailingIcon={trailingIcon}
        className={itemClassName}
      />
    );
  };
  return (
    <>
      <NavGroup>{SETTINGS.map(item)}</NavGroup>
      <NavGroup label="Runtime">{RUNTIME.map(item)}</NavGroup>
    </>
  );
}

function SettingsColumn({ onNavigate }: { onNavigate: (id: string) => void }) {
  return (
    <SettingsNav
      aria-label="Workspace settings"
      className="sticky top-8 self-start"
      header={
        <div className="px-2.5">
          <p className="text-sm leading-5 font-semibold text-fg">Settings</p>
          <p className="truncate text-xs leading-4.5 text-fg-subtle">{currentWorkspace.name}</p>
        </div>
      }
      footer={<OrganizationLink onNavigate={onNavigate} />}
    >
      <SettingsItems onNavigate={onNavigate} />
    </SettingsNav>
  );
}

function SettingsRail({
  onNavigate,
  className,
}: {
  onNavigate: (id: string) => void;
  className?: string;
}) {
  return (
    <SettingsNav
      variant="rail"
      aria-label="Workspace settings"
      className={cn("h-full", className)}
      header={
        <div className="flex flex-col gap-3">
          <NavItem
            href="#back"
            onClick={linkHandler("new-session", onNavigate)}
            icon={<ChevronLeftIcon />}
            label="Back to chats"
            size="comfortable"
          />
          <WorkspaceSwitcher />
        </div>
      }
      footer={<OrganizationLink onNavigate={onNavigate} comfortable />}
    >
      <SettingsItems onNavigate={onNavigate} withIcons comfortable />
    </SettingsNav>
  );
}

/* ----------------------------------------------------------------------------
   Phone chrome: a top bar, and the rail in a left drawer inside the frame (app navigation, not an object sheet).
   -------------------------------------------------------------------------- */

function PhoneNavDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("a[href], button")?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-30 flex"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="relative z-10 flex h-full w-[296px] max-w-[85%] bg-surface shadow-lg"
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none"
      />
    </div>
  );
}

function PhoneTopBar({
  onMenu,
  menuRef,
}: {
  onMenu: () => void;
  menuRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg px-2">
      <Button
        ref={menuRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        onClick={onMenu}
        className="size-11 text-fg-muted hover:text-fg"
      >
        <MenuIcon />
      </Button>
      <span className="grid size-6 shrink-0 place-items-center rounded-[6px] bg-brand-strong/15 text-xs font-semibold text-brand">
        {currentWorkspace.name.charAt(0)}
      </span>
      <span className="min-w-0 truncate text-sm font-medium text-fg">{currentWorkspace.name}</span>
    </div>
  );
}

/** On a phone, the settings sub-nav is its own page. */
function SettingsIndex({ onNavigate }: { onNavigate: (id: string) => void }) {
  return (
    <div className="min-w-0">
      <PageHeader title="Settings" context={currentWorkspace.name} />
      <nav aria-label="Workspace settings" className="-mx-2.5 mt-4 flex flex-col gap-5">
        <SettingsItems
          onNavigate={onNavigate}
          itemClassName="h-11"
          trailingIcon={<ChevronRightIcon />}
        />
        <OrganizationLink onNavigate={onNavigate} />
      </nav>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The frame.
   -------------------------------------------------------------------------- */

export interface FrameHeader {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function AppFrame({
  header,
  settingsIndex = false,
  onNavigate,
  children,
}: {
  /** The page header. Null when the page draws its own (a detail page or a form page). */
  header: FrameHeader | null;
  /** Phones only: show the Settings index instead of the page. */
  settingsIndex?: boolean;
  /** A destination was chosen in the rail, the sub-nav or a back link. */
  onNavigate: (id: string) => void;
  children?: ReactNode;
}) {
  const picks = usePagePicks();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const width = useElementWidth(rootRef);
  const mode = modeFor(width ?? 1200, picks.nav);
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = mode === "phone";
  const frameValue = useMemo(() => ({ mode, nav: picks.nav, scrollRef }), [mode, picks.nav]);

  useEffect(() => {
    if (!phone) setMenuOpen(false);
  }, [phone]);

  const navigate = (id: string) => {
    if (menuOpen) {
      setMenuOpen(false);
      menuRef.current?.focus();
    }
    onNavigate(id);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    menuRef.current?.focus();
  };

  const settingsBack = (
    <button
      type="button"
      onClick={() => navigate("settings")}
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-md transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      Settings
    </button>
  );

  const pageHeader = header ? (
    <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.settingsIcon}>
      <PageHeader
        context={phone && picks.nav !== "tabs" ? settingsBack : undefined}
        icon={header.icon}
        title={header.title}
        meta={header.meta}
        description={header.description}
        actions={header.actions}
      />
    </PageHeaderStyleProvider>
  ) : null;

  const tabsHeader = (
    <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.railIcon}>
      <PageHeader
        icon={<SettingsIcon />}
        title="Settings"
        description={`Everything about ${currentWorkspace.name}, in one place.`}
        // The organization link sits with the title, so seven tabs fit on one row.
        actions={
          phone ? undefined : (
            <NavItem
              href="#organization"
              onClick={linkHandler("organization", navigate)}
              icon={<Building2Icon />}
              label={organization.name}
              trailingIcon={<ArrowRightIcon />}
            />
          )
        }
        tabs={
          <LineTabsNav aria-label="Workspace settings" variant={picks.tabs}>
            {[...SETTINGS, ...RUNTIME].map((destination) => (
              <LineTabsLink
                key={destination.id}
                href={`#${destination.id}`}
                active={destination.id === ACTIVE_SETTINGS_PAGE}
                onClick={linkHandler(destination.id, navigate)}
              >
                {destination.label}
              </LineTabsLink>
            ))}
          </LineTabsNav>
        }
      />
    </PageHeaderStyleProvider>
  );

  // In the tabs layout the page's own title is the active tab, so its
  // description and actions sit in one line under the tabs.
  const tabsIntro =
    header && (header.description || header.actions) ? (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {header.description ? (
          <p className="min-w-0 flex-1 basis-64 text-sm leading-5 text-fg-muted">
            {header.description}
          </p>
        ) : null}
        {header.actions ? (
          <div className="flex shrink-0 items-center gap-2">{header.actions}</div>
        ) : null}
      </div>
    ) : null;

  let content: ReactNode;
  if (phone && settingsIndex) {
    content = (
      <div className="px-4 pt-5 pb-10">
        <SettingsIndex onNavigate={navigate} />
      </div>
    );
  } else if (picks.nav === "tabs") {
    content = (
      <div
        className={cn(
          "mx-auto w-full max-w-[960px]",
          phone ? "px-4 pt-5 pb-10" : "px-8 pt-8 pb-16",
        )}
      >
        {tabsHeader}
        <div className="mt-6 min-w-0">
          {tabsIntro ? <div className="mb-8">{tabsIntro}</div> : null}
          {children}
        </div>
      </div>
    );
  } else if (phone) {
    content = (
      <div className="px-4 pt-5 pb-10">
        {pageHeader}
        <div className={cn("min-w-0", pageHeader && "mt-6")}>{children}</div>
      </div>
    );
  } else if (picks.nav === "column") {
    content = (
      <div className="mx-auto flex w-full max-w-[1200px] gap-10 px-8 pt-8 pb-16">
        <SettingsColumn onNavigate={navigate} />
        <div className="max-w-[960px] min-w-0 flex-1">
          {pageHeader}
          <div className={cn("min-w-0", pageHeader && "mt-8")}>{children}</div>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="mx-auto w-full max-w-[960px] px-8 pt-8 pb-16">
        {pageHeader}
        <div className={cn("min-w-0", pageHeader && "mt-8")}>{children}</div>
      </div>
    );
  }

  const rail =
    picks.nav === "rail" ? (
      <SettingsRail
        onNavigate={navigate}
        className={phone ? "w-full border-r-0 bg-surface" : undefined}
      />
    ) : (
      <MainRail
        collapsed={mode === "compact"}
        onNavigate={navigate}
        className={phone ? "w-full border-r-0 bg-surface" : undefined}
      />
    );

  return (
    <FrameContext.Provider value={frameValue}>
      <div
        ref={rootRef}
        data-frame-mode={mode}
        className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg text-fg"
      >
        {phone ? null : rail}
        <div className="flex min-w-0 flex-1 flex-col">
          {phone ? <PhoneTopBar onMenu={() => setMenuOpen(true)} menuRef={menuRef} /> : null}
          <div
            ref={scrollRef}
            tabIndex={-1}
            aria-label="Page content"
            role="region"
            className="min-h-0 flex-1 overflow-y-auto outline-none [scrollbar-gutter:stable]"
          >
            {content}
          </div>
        </div>
        {phone ? (
          <PhoneNavDrawer open={menuOpen} onClose={closeMenu}>
            {rail}
          </PhoneNavDrawer>
        ) : null}
      </div>
    </FrameContext.Provider>
  );
}
