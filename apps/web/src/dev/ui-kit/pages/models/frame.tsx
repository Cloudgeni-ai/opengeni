import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Building2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContainerIcon,
  CreditCardIcon,
  FingerprintIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LaptopIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlugIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UsersIcon,
  VariableIcon,
  type LucideIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

import { chats, currentWorkspace, organization, you } from "../../fixtures";
import { PagePreview, useKitPane } from "../../kit";
import { KitRailItems, kitRailLabel } from "../kit-rail";
import type { NavLayout } from "./picks";
import type { Scope } from "./state";

/* ----------------------------------------------------------------------------
   The app window around the Models page: the proposed main rail and the
   settings sub-nav, following the Navigation pick.

   - A (column): the rail never swaps; settings has a 200px sub-nav in the
     content area.
   - B (rail): a cleaned settings rail replaces the main rail.
   - C (tabs): one "Settings" header with the sections as tabs.

   The window responds to its own width, like the app responds to the browser:
   1200px and up shows the 240px rail, 640-1199px the collapsed icon rail (the
   kit column at a 1440px window), and under 640px a phone top bar whose menu
   opens the rail as a sheet.
   -------------------------------------------------------------------------- */

export type FrameLayout = "wide" | "medium" | "narrow";

interface Destination {
  id: string;
  label: string;
  icon: LucideIcon;
}

const WORKSPACE_SETTINGS: Destination[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "access", label: "Access", icon: UsersIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "api-keys", label: "API keys", icon: KeyRoundIcon },
];

const RUNTIME_SETTINGS: Destination[] = [
  { id: "variable-sets", label: "Variable sets", icon: VariableIcon },
  { id: "sandbox-environments", label: "Sandbox environments", icon: ContainerIcon },
  { id: "machines", label: "Machines", icon: LaptopIcon },
];

const ORGANIZATION_SETTINGS: Destination[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "people", label: "People", icon: UsersIcon },
  { id: "workspaces", label: "Workspaces", icon: FolderKanbanIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "integrations", label: "Integrations", icon: PlugIcon },
  { id: "identity", label: "Organization identity", icon: FingerprintIcon },
  { id: "billing", label: "Billing & usage", icon: CreditCardIcon },
  { id: "developer", label: "Developer", icon: SquareTerminalIcon },
  { id: "security", label: "Security & data", icon: ShieldCheckIcon },
];

export const MODELS_ICON = SparklesIcon;

const ORG_ADMIN_ONLY = `Only owners and admins of ${organization.name} can open organization settings.`;

function notLive(label: string) {
  toast(`${label} isn't part of this preview`, {
    description: "Its own page preview is under Pages in the kit.",
  });
}

function prevent(event: MouseEvent) {
  event.preventDefault();
}

/* ----------------------------------------------------------------------------
   Frame context: what the page needs to know about the window.
   -------------------------------------------------------------------------- */

interface FrameContextValue {
  layout: FrameLayout;
  nav: NavLayout;
  /** Tabs look for Navigation C, from the Tabs and toolbar pick. */
  tabs: "underline" | "pill";
  scope: Scope;
  /** Phone: show the settings index instead of the page. */
  openIndex: () => void;
  /** Scrolls the page back to the top (after opening a detail page). */
  scrollTop: () => void;
}

const FrameContext = createContext<FrameContextValue>({
  layout: "wide",
  nav: "column",
  tabs: "underline",
  scope: "workspace",
  openIndex: () => undefined,
  scrollTop: () => undefined,
});

export function useFrame(): FrameContextValue {
  return useContext(FrameContext);
}

function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
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

/* ----------------------------------------------------------------------------
   The main rail.
   -------------------------------------------------------------------------- */

function MainRail({
  collapsed,
  onToggle,
  onNavigate,
  className,
}: {
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    // A div, not <aside>: the preview sits inside the kit's own landmarks.
    <div
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-bg",
        collapsed ? "w-14 items-center px-2" : "w-60 px-3",
        className,
      )}
    >
      <div className="w-full pt-3">
        {collapsed ? (
          <span
            role="img"
            aria-label={`Workspace: ${currentWorkspace.name}`}
            className="mx-auto grid size-8 place-items-center rounded-[10px] bg-brand-strong/15 text-xs font-semibold text-brand"
          >
            {currentWorkspace.name.charAt(0)}
          </span>
        ) : (
          <ScopeSwitcherTrigger
            label={currentWorkspace.name}
            icon={currentWorkspace.name.charAt(0)}
            className="w-full"
          />
        )}
      </div>
      <nav aria-label="Main" className="mt-3 w-full">
        <NavGroup collapsed={collapsed}>
          <KitRailItems
            active="settings"
            collapsed={collapsed}
            knowledgeAttention={3}
            onNavigate={(id) => {
              onNavigate?.();
              if (id !== "settings") notLive(kitRailLabel(id));
            }}
          />
        </NavGroup>
      </nav>
      {collapsed ? null : (
        <div className="mt-6 w-full min-w-0">
          <NavGroup label="Chats">
            {chats.map((chat) => (
              <NavItem
                key={chat.id}
                href={`#${chat.id}`}
                onClick={(event) => {
                  prevent(event);
                  notLive("Chats");
                }}
                label={chat.title}
              />
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
        {onToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="shrink-0 rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Settings navigation, for either scope.
   -------------------------------------------------------------------------- */

interface SettingsNavProps {
  scope: Scope;
  viewerIsOrgAdmin: boolean;
  onScope: (scope: Scope) => void;
  /** Icons on items (the rail variant). */
  icons?: boolean;
  size?: "default" | "comfortable";
  /** Phone index: taller rows with a chevron. */
  index?: boolean;
  onModels?: () => void;
}

function SettingsItems({
  scope,
  viewerIsOrgAdmin,
  onScope,
  icons = false,
  size,
  index = false,
  onModels,
}: SettingsNavProps) {
  const item = (destination: Destination) => {
    const Icon = destination.icon;
    const active = destination.id === "models";
    return (
      <NavItem
        key={destination.id}
        href={`#${destination.id}`}
        onClick={(event) => {
          prevent(event);
          if (active) onModels?.();
          else notLive(destination.label);
        }}
        icon={icons ? <Icon /> : undefined}
        label={destination.label}
        active={active && !index}
        size={size}
        trailingIcon={index ? <ChevronRightIcon /> : undefined}
        className={index ? "h-11" : undefined}
      />
    );
  };
  if (scope === "organization") {
    return <NavGroup>{ORGANIZATION_SETTINGS.map(item)}</NavGroup>;
  }
  return (
    <>
      <NavGroup>{WORKSPACE_SETTINGS.map(item)}</NavGroup>
      <NavGroup label="Runtime">{RUNTIME_SETTINGS.map(item)}</NavGroup>
      {index ? (
        <OrganizationLink viewerIsOrgAdmin={viewerIsOrgAdmin} onScope={onScope} size={size} />
      ) : null}
    </>
  );
}

function OrganizationLink({
  viewerIsOrgAdmin,
  onScope,
  size,
}: {
  viewerIsOrgAdmin: boolean;
  onScope: (scope: Scope) => void;
  size?: "default" | "comfortable";
}) {
  return (
    <NavGroup label="Organization">
      <NavItem
        href="#organization"
        onClick={(event) => {
          prevent(event);
          onScope("organization");
        }}
        icon={<Building2Icon />}
        label={organization.name}
        trailingIcon={<ArrowRightIcon />}
        size={size}
        disabledReason={viewerIsOrgAdmin ? undefined : ORG_ADMIN_ONLY}
      />
    </NavGroup>
  );
}

function WorkspaceLink({
  onScope,
  size,
}: {
  onScope: (scope: Scope) => void;
  size?: "default" | "comfortable";
}) {
  return (
    <NavGroup label="Workspace settings">
      <NavItem
        href="#workspace-settings"
        onClick={(event) => {
          prevent(event);
          onScope("workspace");
        }}
        icon={<ArrowLeftIcon />}
        label={currentWorkspace.name}
        size={size}
      />
    </NavGroup>
  );
}

function ScopeTitle({ scope }: { scope: Scope }) {
  return (
    <div className="min-w-0 px-2.5">
      <p className="truncate text-sm leading-5 font-semibold text-fg">
        {scope === "organization" ? "Organization" : "Settings"}
      </p>
      <p className="truncate text-xs leading-4.5 text-fg-subtle">
        {scope === "organization" ? organization.name : currentWorkspace.name}
      </p>
    </div>
  );
}

function SettingsColumn(props: SettingsNavProps) {
  return (
    <SettingsNav
      aria-label={props.scope === "organization" ? "Organization settings" : "Workspace settings"}
      header={<ScopeTitle scope={props.scope} />}
      footer={
        props.scope === "organization" ? (
          <WorkspaceLink onScope={props.onScope} />
        ) : (
          <OrganizationLink viewerIsOrgAdmin={props.viewerIsOrgAdmin} onScope={props.onScope} />
        )
      }
      className="sticky top-8 self-start"
    >
      <SettingsItems {...props} />
    </SettingsNav>
  );
}

function SettingsRail(props: SettingsNavProps & { onNavigate?: () => void; className?: string }) {
  return (
    <SettingsNav
      variant="rail"
      aria-label={props.scope === "organization" ? "Organization settings" : "Workspace settings"}
      header={
        <div className="flex flex-col gap-3">
          <NavItem
            href="#back"
            onClick={(event) => {
              prevent(event);
              props.onNavigate?.();
              notLive("Chats");
            }}
            icon={<ChevronLeftIcon />}
            label="Back to chats"
            size="comfortable"
          />
          {props.scope === "organization" ? (
            <div className="px-2.5">
              <p className="text-xs leading-4.5 font-medium text-fg-subtle">Organization</p>
              <p className="truncate text-sm leading-5 font-semibold text-fg">
                {organization.name}
              </p>
            </div>
          ) : (
            <ScopeSwitcherTrigger
              label={currentWorkspace.name}
              icon={currentWorkspace.name.charAt(0)}
              className="w-full"
            />
          )}
        </div>
      }
      footer={
        props.scope === "organization" ? (
          <WorkspaceLink onScope={props.onScope} size="comfortable" />
        ) : (
          <OrganizationLink
            viewerIsOrgAdmin={props.viewerIsOrgAdmin}
            onScope={props.onScope}
            size="comfortable"
          />
        )
      }
      className={cn("h-full", props.className)}
    >
      <SettingsItems {...props} icons size="comfortable" />
    </SettingsNav>
  );
}

/* ----------------------------------------------------------------------------
   The header every settings page uses, following the Navigation and Page
   header picks. Tabs (Navigation C) replace the page title with "Settings".
   -------------------------------------------------------------------------- */

export function SettingsPageHeader({
  title,
  description,
  actions,
  context,
  onScope,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  /** The org name above the title on organization pages. */
  context?: ReactNode;
  onScope: (scope: Scope) => void;
}) {
  const frame = useFrame();
  const Icon = MODELS_ICON;
  const narrow = frame.layout === "narrow";
  const back = narrow ? (
    <button
      type="button"
      onClick={frame.openIndex}
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-md transition-colors hover:text-fg pointer-coarse:min-h-11"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      {frame.scope === "organization" ? "Organization settings" : "Settings"}
    </button>
  ) : null;

  if (frame.nav === "tabs" && !narrow) {
    const items =
      frame.scope === "organization"
        ? ORGANIZATION_SETTINGS
        : [...WORKSPACE_SETTINGS, ...RUNTIME_SETTINGS];
    return (
      <PageHeader
        icon={<SettingsIcon />}
        title={frame.scope === "organization" ? "Organization settings" : "Settings"}
        context={frame.scope === "organization" ? organization.name : currentWorkspace.name}
        description={
          frame.scope === "organization"
            ? `Everything about ${organization.name}, in one place.`
            : `Everything about ${currentWorkspace.name}, in one place.`
        }
        actions={actions}
        tabs={
          <LineTabsNav
            variant={frame.tabs}
            aria-label={
              frame.scope === "organization" ? "Organization settings" : "Workspace settings"
            }
            trailing={
              frame.scope === "organization" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onScope("workspace")}
                  className="text-fg-muted"
                >
                  <ArrowLeftIcon aria-hidden="true" />
                  {currentWorkspace.name}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onScope("organization")}
                  className="text-fg-muted"
                >
                  <Building2Icon aria-hidden="true" />
                  {organization.name}
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              )
            }
          >
            {items.map((item) => (
              <LineTabsLink
                key={item.id}
                href={`#${item.id}`}
                active={item.id === "models"}
                onClick={(event) => {
                  prevent(event);
                  if (item.id !== "models") notLive(item.label);
                }}
              >
                {item.label}
              </LineTabsLink>
            ))}
          </LineTabsNav>
        }
      />
    );
  }

  return (
    <PageHeader
      icon={<Icon />}
      title={title}
      description={description}
      actions={actions}
      context={back ?? context}
    />
  );
}

/* ----------------------------------------------------------------------------
   The window.
   -------------------------------------------------------------------------- */

const NARROW = 640;
const WIDE = 1200;

export function ModelsFrame({
  label,
  nav,
  tabs = "underline",
  scope,
  viewerIsOrgAdmin,
  onScope,
  headerVariant,
  headerIcon,
  children,
}: {
  label: string;
  nav: NavLayout;
  tabs?: "underline" | "pill";
  scope: Scope;
  viewerIsOrgAdmin: boolean;
  onScope: (scope: Scope) => void;
  headerVariant: "default" | "large";
  headerIcon: "show" | "hide";
  children: ReactNode;
}) {
  const pane = useKitPane();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const mainRef = useRef<HTMLDivElement>(null);
  const [railPreference, setRailPreference] = useState<"full" | "collapsed" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [index, setIndex] = useState(false);
  const layout: FrameLayout =
    width === 0
      ? pane.mobileFrame
        ? "narrow"
        : "wide"
      : width < NARROW
        ? "narrow"
        : width < WIDE
          ? "medium"
          : "wide";
  const railMode = railPreference ?? (layout === "wide" ? "full" : "collapsed");
  const height = pane.mobileFrame ? 780 : 880;
  const navProps: SettingsNavProps = {
    scope,
    viewerIsOrgAdmin,
    onScope: (next) => {
      setIndex(false);
      setMenuOpen(false);
      onScope(next);
    },
  };
  const frameValue = useMemo<FrameContextValue>(
    () => ({
      layout,
      nav,
      tabs,
      scope,
      openIndex: () => setIndex(true),
      scrollTop: () => mainRef.current?.scrollTo({ top: 0 }),
    }),
    [layout, nav, scope, tabs],
  );

  const rail = (inMenu: boolean) =>
    nav === "rail" ? (
      <SettingsRail
        {...navProps}
        onModels={() => {
          setMenuOpen(false);
          setIndex(false);
        }}
        onNavigate={() => setMenuOpen(false)}
        className={inMenu ? "w-full border-r-0" : undefined}
      />
    ) : (
      <MainRail
        collapsed={inMenu ? false : railMode === "collapsed"}
        onToggle={
          inMenu ? undefined : () => setRailPreference(railMode === "full" ? "collapsed" : "full")
        }
        onNavigate={() => setMenuOpen(false)}
        className={inMenu ? "w-full border-r-0" : undefined}
      />
    );

  const content =
    layout === "narrow" && index ? (
      <div className="px-4 pt-6 pb-16">
        <PageHeader
          title={scope === "organization" ? "Organization settings" : "Settings"}
          context={scope === "organization" ? organization.name : currentWorkspace.name}
        />
        <nav
          aria-label={scope === "organization" ? "Organization settings" : "Workspace settings"}
          className="-mx-2.5 mt-4 flex flex-col gap-5"
        >
          <SettingsItems {...navProps} index onModels={() => setIndex(false)} />
          {scope === "organization" ? <WorkspaceLink onScope={navProps.onScope} /> : null}
        </nav>
      </div>
    ) : nav === "column" && layout !== "narrow" ? (
      <div className="mx-auto flex w-full max-w-[1120px] min-w-0 gap-10 px-8 pt-8 pb-16">
        <SettingsColumn {...navProps} />
        <div className="max-w-[760px] min-w-0 flex-1">{children}</div>
      </div>
    ) : (
      <div
        className={cn(
          "mx-auto w-full min-w-0 pb-16",
          layout === "narrow" ? "px-4 pt-6" : "px-8 pt-8",
          nav === "tabs" ? "max-w-[1024px]" : "max-w-[824px]",
        )}
      >
        {children}
      </div>
    );

  return (
    <FrameContext.Provider value={frameValue}>
      <PageHeaderStyleProvider variant={headerVariant} icon={headerIcon}>
        <PagePreview
          label={label}
          height={height}
          className={cn(pane.mobileFrame && "-mx-4 rounded-none border-x-0")}
        >
          <div
            ref={ref}
            data-layout={layout}
            className="@container/app flex h-full min-h-0 min-w-0 bg-bg text-fg"
          >
            {layout === "narrow" ? null : rail(false)}
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
                        {rail(true)}
                      </DialogPrimitive.Content>
                    </DialogPrimitive.Portal>
                  </DialogPrimitive.Root>
                  <p className="min-w-0 truncate text-sm font-medium text-fg">
                    {scope === "organization" ? organization.name : currentWorkspace.name}
                  </p>
                </div>
              ) : null}
              <div
                ref={mainRef}
                data-slot="kit-app-main"
                className="@container/main min-h-0 min-w-0 flex-1 overflow-y-auto"
              >
                {content}
              </div>
            </div>
          </div>
        </PagePreview>
      </PageHeaderStyleProvider>
    </FrameContext.Provider>
  );
}
