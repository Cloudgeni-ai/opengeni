import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainCircuitIcon,
  Building2Icon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContainerIcon,
  GaugeIcon,
  GraduationCapIcon,
  InboxIcon,
  KeyRoundIcon,
  LaptopIcon,
  LibraryIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  UsersIcon,
  VariableIcon,
  type LucideIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { cn } from "@/lib/utils";

import { chats, organization, organizationRoles, type Person } from "../../fixtures";
import type { SectionKey } from "../../sections/registry";
import { useKitNavigate, useKitView } from "../../view";
import { useElementWidth } from "./controls";
import { useSettingsPicks, type SettingsNavLayout } from "./picks";

/* ----------------------------------------------------------------------------
   Destinations. Every one once, with one name and one icon; the rail label is
   the page title and the route noun.
   -------------------------------------------------------------------------- */

export type SettingsPageId =
  | "general"
  | "access"
  | "models"
  | "api-keys"
  | "variable-sets"
  | "sandbox-environments"
  | "machines"
  | "agent-learning"
  | "capabilities"
  | "danger-zone"
  | "agents"
  | "insights"
  | "memory";

/** "index" is the settings list itself, shown when there is no room for the sub-nav. */
export type FramePage = SettingsPageId | "index";

interface Destination {
  id: SettingsPageId;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Another kit page preview that shows this destination. */
  preview?: { section: SectionKey; label: string };
  /** Why this destination isn't in this preview (placeholder copy). */
  note?: string;
}

function destinations(workspaceName: string): Record<SettingsPageId, Destination> {
  return {
    general: {
      id: "general",
      label: "General",
      icon: SlidersHorizontalIcon,
      description: "Name, agent activity and defaults for new sessions.",
    },
    access: {
      id: "access",
      label: "Access",
      icon: UsersIcon,
      description: `People from ${organization.name} who can use ${workspaceName}.`,
    },
    models: {
      id: "models",
      label: "Models",
      icon: SparklesIcon,
      description: "How new work in this workspace is paid for and which models it may use.",
      preview: { section: "page-models", label: "Open the Models preview" },
    },
    "api-keys": {
      id: "api-keys",
      label: "API keys",
      icon: KeyRoundIcon,
      description: "Keys that let your own tools start work in this workspace.",
    },
    "variable-sets": {
      id: "variable-sets",
      label: "Variable sets",
      icon: VariableIcon,
      description: "Environment variables and secrets your agents get in their sandbox.",
      preview: { section: "page-variable-sets", label: "Open the Variable sets preview" },
    },
    "sandbox-environments": {
      id: "sandbox-environments",
      label: "Sandbox environments",
      icon: ContainerIcon,
      description: "Setup scripts and checks for the sandboxes agents work in.",
      note: "Sandbox environments follows the Variable sets layout: a list, and a detail page per environment.",
      preview: { section: "page-variable-sets", label: "Open the Variable sets preview" },
    },
    machines: {
      id: "machines",
      label: "Machines",
      icon: LaptopIcon,
      description: "Your own computers, connected to run agent work.",
      note: "Machines isn't part of the page previews yet.",
    },
    "agent-learning": {
      id: "agent-learning",
      label: "Agent learning",
      icon: GraduationCapIcon,
      description: "How agents save knowledge, instructions and skills.",
      note: "With question 5 answered Yes, learning moves into the Knowledge page as a Learning sheet.",
      preview: { section: "page-knowledge", label: "Open the Knowledge preview" },
    },
    capabilities: {
      id: "capabilities",
      label: "Capabilities",
      icon: PlugIcon,
      description: "Tools, skills, and plugins your agents can use.",
      note: "Today this page only links to Capabilities in the main rail. Question 5 removes it.",
    },
    "danger-zone": {
      id: "danger-zone",
      label: "Danger zone",
      icon: TriangleAlertIcon,
      description: "Delete this workspace.",
    },
    agents: {
      id: "agents",
      label: "Agents",
      icon: BotIcon,
      description: "Every workstream in this workspace, live.",
      note: "Agents is a live view of work, not a setting. Question 5 moves it to the main rail.",
    },
    insights: {
      id: "insights",
      label: "Insights",
      icon: GaugeIcon,
      description: "Usage and spend for this workspace.",
      note: "Insights is a dashboard, not a setting. Question 5 moves it to the main rail for admins.",
    },
    memory: {
      id: "memory",
      label: "Memory",
      icon: LibraryIcon,
      description: "What your agents know.",
      note: "Memory is an old name for the Knowledge page. Question 5 removes it; old links redirect.",
      preview: { section: "page-knowledge", label: "Open the Knowledge preview" },
    },
  };
}

interface NavLayoutOptions {
  /** Question 5: settings holds configuration only. */
  settingsOnly: boolean;
  /** Question 6 answered No: Danger zone keeps its own page. */
  dangerZonePage: boolean;
}

function settingsGroups({
  settingsOnly,
  dangerZonePage,
}: NavLayoutOptions): Array<{ label?: string; items: SettingsPageId[] }> {
  const danger: SettingsPageId[] = dangerZonePage ? ["danger-zone"] : [];
  const runtime = {
    label: "Runtime",
    items: ["variable-sets", "sandbox-environments", "machines"] as SettingsPageId[],
  };
  if (settingsOnly) {
    return [{ items: ["general", "access", "models", "api-keys", ...danger] }, runtime];
  }
  return [
    {
      items: [
        "general",
        "agent-learning",
        "access",
        "models",
        "capabilities",
        "api-keys",
        ...danger,
      ],
    },
    { label: "Workspace activity", items: ["agents", "insights", "memory"] },
    runtime,
  ];
}

interface RailDestination {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  attention?: boolean;
}

function railDestinations(settingsOnly: boolean): RailDestination[] {
  const all: Array<RailDestination & { movedIn?: boolean }> = [
    { id: "new-session", label: "New session", icon: SquarePenIcon },
    { id: "for-you", label: "For you", icon: InboxIcon, badge: "2" },
    { id: "agents", label: "Agents", icon: BotIcon, movedIn: true },
    { id: "schedules", label: "Schedules", icon: CalendarClockIcon },
    { id: "artifacts", label: "Artifacts", icon: PanelsTopLeftIcon },
    { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon, attention: true },
    { id: "capabilities", label: "Capabilities", icon: PlugIcon },
    { id: "insights", label: "Insights", icon: GaugeIcon, movedIn: true },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];
  return all.filter((item) => settingsOnly || !item.movedIn);
}

function prevent(event: MouseEvent) {
  event.preventDefault();
}

/* ----------------------------------------------------------------------------
   Pieces.
   -------------------------------------------------------------------------- */

function WorkspaceSwitcher({ name }: { name: string }) {
  return <ScopeSwitcherTrigger label={name} icon={name.charAt(0)} className="w-full" />;
}

function orgRoleLabel(person: Person): string {
  return organizationRoles.find((role) => role.id === person.organizationRole)?.label ?? "Member";
}

function AccountRow({
  viewer,
  collapsed,
  onToggleRail,
}: {
  viewer: Person;
  collapsed: boolean;
  onToggleRail?: () => void;
}) {
  const ToggleIcon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  const toggle = onToggleRail ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onToggleRail}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="shrink-0 text-fg-subtle hover:text-fg pointer-coarse:size-11"
    >
      <ToggleIcon />
    </Button>
  ) : null;
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2">
        {toggle}
        <Avatar size="sm" aria-label={viewer.name}>
          <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
            {viewer.initials}
          </AvatarFallback>
        </Avatar>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar size="sm" aria-hidden="true">
        <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
          {viewer.initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-5 font-medium text-fg">{viewer.name}</p>
        <p className="truncate text-2xs text-fg-subtle">
          {orgRoleLabel(viewer)} · {organization.name}
        </p>
      </div>
      {toggle}
    </div>
  );
}

function MainRail({
  collapsed,
  settingsOnly,
  workspaceName,
  viewer,
  onOpenSettings,
  onToggleRail,
  className,
}: {
  collapsed: boolean;
  settingsOnly: boolean;
  workspaceName: string;
  viewer: Person;
  onOpenSettings: () => void;
  onToggleRail?: () => void;
  className?: string;
}) {
  return (
    <aside
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
            aria-label={workspaceName}
            className="mx-auto grid size-8 place-items-center rounded-[10px] bg-brand-strong/15 text-xs font-semibold text-brand"
          >
            {workspaceName.charAt(0)}
          </span>
        ) : (
          <WorkspaceSwitcher name={workspaceName} />
        )}
      </div>
      <nav aria-label="Main" className="mt-3 w-full">
        <NavGroup collapsed={collapsed}>
          {railDestinations(settingsOnly).map((item) => {
            const Icon = item.icon;
            const settings = item.id === "settings";
            return (
              <NavItem
                key={item.id}
                href={`#${item.id}`}
                onClick={(event) => {
                  prevent(event);
                  if (settings) onOpenSettings();
                }}
                icon={<Icon />}
                label={item.label}
                badge={item.badge}
                attention={item.attention}
                attentionLabel="3 waiting for review"
                active={settings}
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
      <div className="mt-auto w-full border-t border-border py-3">
        <AccountRow viewer={viewer} collapsed={collapsed} onToggleRail={onToggleRail} />
      </div>
    </aside>
  );
}

function OrganizationLink({ comfortable }: { comfortable?: boolean }) {
  const view = useKitView();
  const navigate = useKitNavigate(view);
  return (
    <NavGroup label="Organization">
      <NavItem
        href="#organization"
        onClick={(event) => {
          prevent(event);
          navigate({ section: "page-org-people" });
        }}
        label={organization.name}
        icon={<Building2Icon />}
        trailingIcon={<ArrowRightIcon />}
        size={comfortable ? "comfortable" : "default"}
      />
    </NavGroup>
  );
}

function SettingsItems({
  page,
  onNavigate,
  layout,
  withIcons = false,
  comfortable = false,
  trailingIcon,
  itemClassName,
}: {
  page: FramePage;
  onNavigate: (page: FramePage) => void;
  layout: NavLayoutOptions;
  withIcons?: boolean;
  comfortable?: boolean;
  trailingIcon?: ReactNode;
  itemClassName?: string;
}) {
  const all = destinations("");
  return (
    <>
      {settingsGroups(layout).map((group) => (
        <NavGroup key={group.label ?? "settings"} label={group.label}>
          {group.items.map((id) => {
            const destination = all[id];
            const Icon = destination.icon;
            return (
              <NavItem
                key={id}
                href={`#${id}`}
                onClick={(event) => {
                  prevent(event);
                  onNavigate(id);
                }}
                icon={withIcons ? <Icon /> : undefined}
                label={destination.label}
                active={page === id}
                size={comfortable ? "comfortable" : "default"}
                trailingIcon={trailingIcon}
                className={itemClassName}
              />
            );
          })}
        </NavGroup>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------------------
   Placeholder for destinations other previews own.
   -------------------------------------------------------------------------- */

function ElsewherePage({ destination }: { destination: Destination }) {
  const view = useKitView();
  const navigate = useKitNavigate(view);
  const Icon = destination.icon;
  return (
    <EmptyState
      variant="page"
      icon={<Icon />}
      title={
        destination.preview
          ? `${destination.label} has its own page preview`
          : `${destination.label} isn't in this preview`
      }
      description={
        destination.note ?? "General, Access and API keys share this frame; open the others here."
      }
      action={
        destination.preview ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate({ section: destination.preview!.section })}
          >
            {destination.preview.label}
            <ArrowUpRightIcon aria-hidden="true" />
          </Button>
        ) : undefined
      }
    />
  );
}

/* ----------------------------------------------------------------------------
   The frame.
   -------------------------------------------------------------------------- */

export interface SettingsFrameProps {
  page: FramePage;
  onNavigate: (page: FramePage) => void;
  /** Question 4 overrides the navigation pick: "rail" when the rail swaps. */
  nav: SettingsNavLayout;
  /** Question 5. */
  settingsOnly: boolean;
  /** Question 6 answered No. */
  dangerZonePage: boolean;
  workspaceName: string;
  viewer: Person;
  /** A workspace-wide banner above every page (agent work paused). */
  banner?: ReactNode;
  /** The page header's actions. Keep one primary. */
  actions?: ReactNode;
  /** Inline after the title. */
  meta?: ReactNode;
  /** Replaces the header and body: a full-page form or a detail page. */
  takeover?: ReactNode;
  /**
   * The takeover is a detail page: it gets the whole content width (the
   * settings sub-nav column steps aside), so its aside card has room.
   */
  takeoverWide?: boolean;
  /** Changes whenever the takeover changes (another page opens), to reset the scroll position. */
  takeoverKey?: string;
  /** Renders pages this frame doesn't own. Return null to use the placeholder. */
  children?: ReactNode;
  /** Changes whenever the visible page changes, to reset the scroll position. */
  scrollKey?: string;
}

const PHONE_MAX = 640;
/**
 * The narrowest page column that keeps every control in its right-hand column:
 * setting rows and fact columns switch at 640px, and a sub-row sits 24px in.
 */
const PAGE_MIN = 664;
/** Padding (2 x 32), the 200px sub-nav column and its 40px gap, plus the page. */
const COLUMN_MIN_CONTENT = 64 + 200 + 40 + PAGE_MIN;
/** Below this the main rail folds to icons, so the page keeps its width. */
const WIDE_MIN = { column: 240 + COLUMN_MIN_CONTENT, tabs: 240 + 64 + PAGE_MIN, rail: 1024 };

export function SettingsFrame({
  page,
  onNavigate,
  nav,
  settingsOnly,
  dangerZonePage,
  workspaceName,
  viewer,
  banner,
  actions,
  meta,
  takeover,
  takeoverWide = false,
  takeoverKey,
  children,
  scrollKey,
}: SettingsFrameProps) {
  const picks = useSettingsPicks();
  const [frameRef, width] = useElementWidth<HTMLDivElement>();
  const [railPreference, setRailPreference] = useState<"auto" | "expanded" | "collapsed">("auto");
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = { settingsOnly, dangerZonePage };

  const measured = width ?? 1136;
  const phone = measured < PHONE_MAX;
  const railCollapsed =
    railPreference === "auto" ? measured < WIDE_MIN[nav] : railPreference === "collapsed";
  const railWidth = phone ? 0 : nav === "rail" ? 240 : railCollapsed ? 56 : 240;
  const contentWidth = measured - railWidth;
  const showColumn = nav === "column" && !phone && contentWidth >= COLUMN_MIN_CONTENT;
  const backLinks = nav === "column" && !showColumn;
  // The settings list is a page of its own only where the sub-nav has no room.
  const current: FramePage = page === "index" && !backLinks ? "general" : page;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [current, scrollKey, takeoverKey]);

  const all = destinations(workspaceName);
  const destination = current === "index" ? null : all[current];
  const Icon = destination?.icon ?? SettingsIcon;
  const navigate = (next: FramePage) => {
    setMenuOpen(false);
    onNavigate(next);
  };

  const backLink = (
    <a
      href="#settings"
      onClick={(event) => {
        prevent(event);
        navigate("index");
      }}
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-md transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      Settings
    </a>
  );

  const ownsPage = current === "general" || current === "access" || current === "api-keys";
  const body =
    destination && !ownsPage && current !== "danger-zone" ? (
      <ElsewherePage destination={destination} />
    ) : (
      children
    );

  let pageContent: ReactNode;
  if (current === "index") {
    pageContent = (
      <>
        <PageHeader title="Settings" context={workspaceName} />
        <nav aria-label="Workspace settings" className="-mx-2.5 mt-4 flex flex-col gap-5">
          <SettingsItems
            page={current}
            onNavigate={navigate}
            layout={layout}
            withIcons
            trailingIcon={<ChevronRightIcon />}
            itemClassName="h-11"
          />
          <OrganizationLink />
        </nav>
      </>
    );
  } else if (nav === "tabs") {
    const items = settingsGroups(layout).flatMap((group) => group.items);
    pageContent = (
      <>
        <PageHeader
          icon={<SettingsIcon />}
          title="Settings"
          description={`Everything about ${workspaceName}, in one place.`}
          actions={takeover ? undefined : actions}
          tabs={
            <LineTabsNav aria-label="Workspace settings">
              {items.map((id) => (
                <LineTabsLink
                  key={id}
                  href={`#${id}`}
                  active={current === id}
                  onClick={(event) => {
                    prevent(event);
                    navigate(id);
                  }}
                >
                  {all[id].label}
                </LineTabsLink>
              ))}
            </LineTabsNav>
          }
        />
        <div className="mt-6">{takeover ?? body}</div>
      </>
    );
  } else {
    pageContent = takeover ?? (
      <>
        <PageHeader
          icon={<Icon />}
          title={destination!.label}
          description={destination!.description}
          context={backLinks ? backLink : undefined}
          meta={meta}
          actions={actions}
        />
        <div className="mt-6">{body}</div>
      </>
    );
  }

  const wideTakeover = Boolean(takeover) && takeoverWide;
  const column =
    showColumn && !wideTakeover ? (
      <SettingsNav
        aria-label="Workspace settings"
        className="sticky top-8 self-start"
        header={
          <div className="px-2.5">
            <p className="text-sm leading-5 font-semibold text-fg">Settings</p>
            <p className="truncate text-xs leading-4.5 text-fg-subtle">{workspaceName}</p>
          </div>
        }
        footer={<OrganizationLink />}
      >
        <SettingsItems page={current} onNavigate={navigate} layout={layout} />
      </SettingsNav>
    ) : null;

  const settingsRail = (
    <SettingsNav
      variant="rail"
      aria-label="Workspace settings"
      className={cn("h-full", phone && "w-full border-r-0")}
      header={
        <div className="flex flex-col gap-3">
          <NavItem
            href="#back"
            onClick={prevent}
            icon={<ChevronLeftIcon />}
            label="Back to chats"
            size="comfortable"
          />
          <WorkspaceSwitcher name={workspaceName} />
        </div>
      }
      footer={<OrganizationLink comfortable />}
    >
      <SettingsItems page={current} onNavigate={navigate} layout={layout} withIcons comfortable />
    </SettingsNav>
  );

  const mainRail = (collapsed: boolean, inDrawer = false) => (
    <MainRail
      collapsed={collapsed}
      settingsOnly={settingsOnly}
      workspaceName={workspaceName}
      viewer={viewer}
      onOpenSettings={() => navigate(backLinks ? "index" : "general")}
      onToggleRail={
        inDrawer ? undefined : () => setRailPreference(railCollapsed ? "expanded" : "collapsed")
      }
      className={inDrawer ? "w-full border-r-0" : undefined}
    />
  );

  const main = (
    <div
      className={cn(
        "flex min-w-0 gap-10",
        phone ? "px-4 pt-5 pb-12" : "mx-auto w-full px-8 pt-8 pb-16",
        showColumn || wideTakeover
          ? "max-w-[1040px]"
          : nav === "tabs"
            ? "max-w-[1024px]"
            : "max-w-[800px]",
      )}
    >
      {column}
      <main
        aria-label={destination ? destination.label : "Settings"}
        className={cn("min-w-0 flex-1", showColumn && !wideTakeover && "max-w-[720px]")}
      >
        {pageContent}
      </main>
    </div>
  );

  return (
    <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.headerIcon}>
      <div
        ref={frameRef}
        data-frame-width={phone ? "phone" : railCollapsed ? "compact" : "wide"}
        className={cn("flex w-full min-w-0 text-fg", phone ? "flex-col" : "h-[880px]")}
      >
        {phone ? (
          <>
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                onClick={() => setMenuOpen(true)}
                className="size-11 text-fg-muted hover:text-fg"
              >
                <MenuIcon />
              </Button>
              <div className="min-w-0 flex-1 pr-2">
                <ScopeSwitcherTrigger
                  compact
                  label={workspaceName}
                  icon={workspaceName.charAt(0)}
                  className="max-w-full"
                />
              </div>
            </div>
            <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 starting:opacity-0" />
                <DialogPrimitive.Content
                  aria-describedby={undefined}
                  className="fixed inset-y-0 left-0 z-50 flex w-[296px] max-w-[85vw] flex-col bg-bg shadow-lg outline-none transition-transform duration-200 ease-out starting:-translate-x-full motion-reduce:transition-none"
                >
                  <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
                  {nav === "rail" ? settingsRail : mainRail(false, true)}
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
            {banner}
            {main}
          </>
        ) : (
          <>
            {nav === "rail" ? settingsRail : mainRail(railCollapsed)}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {banner}
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                {main}
              </div>
            </div>
          </>
        )}
      </div>
    </PageHeaderStyleProvider>
  );
}
