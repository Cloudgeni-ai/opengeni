import { useState, type ReactNode } from "react";
import {
  ArrowRightIcon,
  BarChart3Icon,
  BrainCircuitIcon,
  Building2Icon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContainerIcon,
  KeyRoundIcon,
  LaptopIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  SendIcon,
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
import { CopyField } from "@/components/ui/copy-field";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { PageHeader, PageHeaderStyleProvider } from "@/components/ui/page-header";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import { Section, SectionStack, type SectionVariant } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow } from "@/components/ui/setting-row";
import {
  NavGroup,
  NavItem,
  NavItemSkeleton,
  SettingsNav,
  type NavItemSize,
} from "@/components/ui/settings-nav";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  chats,
  currentWorkspace,
  designPreviewAccess,
  organization,
  personById,
  variableSets,
  workspaces,
  you,
} from "../fixtures";
import { usePick } from "../picks";
import { Alternative, Fork, KitBlock, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { KitRailItems, type KitRailId } from "../pages/kit-rail";

/* ----------------------------------------------------------------------------
   Destinations: every one once, with one name and one icon.
   -------------------------------------------------------------------------- */

interface Destination {
  id: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  badge?: string;
  attention?: boolean;
}

/** Every main-rail destination with the real icon; the rail itself is `KitRailItems`. */
const RAIL: Destination[] = [
  { id: "new-session", label: "New session", icon: SquarePenIcon },
  { id: "for-you", label: "For you", icon: SendIcon, badge: "2" },
  { id: "capabilities", label: "Capabilities", icon: PlugIcon },
  { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon, attention: true },
  { id: "schedules", label: "Schedules", icon: CalendarClockIcon },
  { id: "artifacts", label: "Artifacts", icon: PanelsTopLeftIcon },
  { id: "settings", label: "Settings", icon: SlidersHorizontalIcon },
];

const SETTINGS: Destination[] = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontalIcon,
  },
  {
    id: "access",
    label: "Access",
    icon: UsersIcon,
    description: `People from ${organization.name} who can use ${currentWorkspace.name}.`,
  },
  {
    id: "models",
    label: "Models",
    icon: SparklesIcon,
    description: "How new work in this workspace is paid for and which models it may use.",
  },
  {
    id: "api-keys",
    label: "API keys",
    icon: KeyRoundIcon,
    description: "Keys that let your own tools start work in this workspace.",
  },
];

const RUNTIME: Destination[] = [
  {
    id: "variable-sets",
    label: "Variable sets",
    icon: VariableIcon,
    description: "Environment variables and secrets your agents get in their sandbox.",
  },
  {
    id: "sandbox-environments",
    label: "Sandbox environments",
    icon: ContainerIcon,
    description: "Setup scripts and checks for the sandboxes agents work in.",
  },
  {
    id: "machines",
    label: "Machines",
    icon: LaptopIcon,
    description: "Your own computers, connected to run agent work.",
  },
];

const ALL_SETTINGS = [...SETTINGS, ...RUNTIME];

function settingsPage(id: string): Destination {
  return ALL_SETTINGS.find((item) => item.id === id) ?? SETTINGS[0]!;
}

function prevent(event: { preventDefault: () => void }) {
  event.preventDefault();
}

/* ----------------------------------------------------------------------------
   Page content, following the current page-header and section picks.
   -------------------------------------------------------------------------- */

function usePagePicks(): {
  headerVariant: "default" | "large";
  iconMode: "show" | "hide";
  section: SectionVariant;
} {
  const header = usePick("page-header");
  const section = usePick("section");
  return {
    headerVariant: header === "c" ? "large" : "default",
    iconMode: header === "a" ? "show" : "hide",
    section: section === "b" ? "group" : section === "c" ? "tiles" : "open",
  };
}

function GeneralBody({ variant }: { variant: SectionVariant }) {
  return (
    <SectionStack variant={variant}>
      <Section aria-label="Workspace">
        <SettingRow
          label="Name"
          description={
            <span className="mt-0.5 block text-sm leading-5 break-words text-fg">
              {currentWorkspace.name}
            </span>
          }
          control={
            <Button variant="outline" size="sm">
              <PencilIcon aria-hidden="true" />
              Rename
            </Button>
          }
        />
        <SettingRow
          label="Workspace ID"
          description={
            <span className="mt-0.5 flex min-w-0">
              <CopyField value={currentWorkspace.id} label="workspace ID" truncate="middle" />
            </span>
          }
        />
      </Section>
      <Section
        title="New session defaults"
        description="Applied when someone starts a new session in this workspace."
      >
        <SettingRow
          label="Voice input"
          description="Record a short message and add its transcript to the draft."
          control={<Switch defaultChecked />}
        />
        <SettingRow
          label="Fast code search"
          description="Index repositories so agents find code faster."
          controlWidth="auto"
          control={
            <SegmentedControl
              size="sm"
              defaultValue="default"
              options={[
                { value: "default", label: "Default" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          }
        />
      </Section>
    </SectionStack>
  );
}

function AccessBody() {
  return (
    <RowList label="People with access" variant="resource">
      {designPreviewAccess.map((entry) => {
        const person = personById(entry.personId);
        return (
          <ListRow
            key={entry.personId}
            leading={
              <Avatar size="sm">
                <AvatarFallback className="text-2xs font-semibold">
                  {person.initials}
                </AvatarFallback>
              </Avatar>
            }
            title={person.name}
            description={person.email ?? "Service account"}
            onOpen={() => undefined}
            indicator="open"
          />
        );
      })}
    </RowList>
  );
}

function VariableSetsBody() {
  return (
    <RowList label="Variable sets" variant="resource">
      {variableSets.slice(0, 4).map((set) => (
        <ListRow
          key={set.id}
          leading={<LogoTile name={set.name} icon={<VariableIcon />} />}
          title={set.name}
          meta={[set.variablesLabel, set.usageLabel, `Updated ${set.updatedLabel}`]}
          onOpen={() => undefined}
          indicator="open"
        />
      ))}
    </RowList>
  );
}

function PageBody({ page, variant }: { page: string; variant: SectionVariant }) {
  if (page === "general") return <GeneralBody variant={variant} />;
  if (page === "access") return <AccessBody />;
  if (page === "variable-sets") return <VariableSetsBody />;
  return null;
}

function PageActions({ page }: { page: string }) {
  if (page === "access")
    return (
      <Button>
        <PlusIcon aria-hidden="true" />
        Add people
      </Button>
    );
  if (page === "variable-sets")
    return (
      <Button>
        <PlusIcon aria-hidden="true" />
        New variable set
      </Button>
    );
  return null;
}

function SettingsPageContent({ page, withHeader = true }: { page: string; withHeader?: boolean }) {
  const picks = usePagePicks();
  const destination = settingsPage(page);
  const Icon = destination.icon;
  return (
    <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.iconMode}>
      {withHeader ? (
        <PageHeader
          icon={<Icon />}
          title={destination.label}
          description={destination.description}
          actions={<PageActions page={page} />}
        />
      ) : null}
      <div className={withHeader ? "mt-6" : undefined}>
        <PageBody page={page} variant={picks.section} />
      </div>
    </PageHeaderStyleProvider>
  );
}

/* ----------------------------------------------------------------------------
   The main rail and the app window.
   -------------------------------------------------------------------------- */

function WorkspaceSwitcher({ name = currentWorkspace.name }: { name?: string }) {
  return <ScopeSwitcherTrigger label={name} icon={name.charAt(0)} className="w-full" />;
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
          <p className="truncate text-2xs text-fg-subtle">Owner · {organization.name}</p>
        </div>
      )}
    </div>
  );
}

function MainRail({
  active,
  onSelect,
  collapsed = false,
  className,
}: {
  active: string;
  onSelect?: (id: string) => void;
  collapsed?: boolean;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-bg",
        collapsed ? "w-14 items-center px-2" : "w-60 px-3",
        className,
      )}
    >
      <div className="w-full pt-3">
        {collapsed ? (
          <span className="mx-auto grid size-8 place-items-center rounded-[10px] bg-brand-strong/15 text-xs font-semibold text-brand">
            {currentWorkspace.name.charAt(0)}
          </span>
        ) : (
          <WorkspaceSwitcher />
        )}
      </div>
      <nav aria-label="Main" className="mt-3 w-full">
        <NavGroup collapsed={collapsed}>
          <KitRailItems
            active={active as KitRailId}
            collapsed={collapsed}
            knowledgeAttention={3}
            onNavigate={onSelect}
          />
        </NavGroup>
      </nav>
      {collapsed ? null : (
        <div className="mt-6 w-full">
          <NavGroup label="Chats">
            {chats.map((chat) => (
              <NavItem key={chat.id} href={`#${chat.id}`} onClick={prevent} label={chat.title} />
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

/**
 * A desktop window drawn at 1340x720 and scaled with CSS zoom, so the real
 * primitives keep their real sizes and the frame still fits the kit column.
 */
function AppWindow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div
        role="region"
        aria-label={label}
        className="[zoom:0.23] @[420px]/kit-section:[zoom:0.28] @[480px]/kit-section:[zoom:0.32] @[576px]/kit-section:[zoom:0.38] @[680px]/kit-section:[zoom:0.46] @[768px]/kit-section:[zoom:0.53] @[900px]/kit-section:[zoom:0.63] @[1024px]/kit-section:[zoom:0.72] @[1060px]/kit-section:[zoom:0.76]"
      >
        <div className="flex h-[720px] w-[1340px] overflow-hidden rounded-[16px] border border-border bg-bg text-fg shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

/** A 390px phone drawn at real size and scaled down. */
function PhoneFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mx-auto min-w-0 overflow-hidden">
      <div role="region" aria-label={label} className="[zoom:0.62] @xl/kit-section:[zoom:0.74]">
        <div className="relative h-[780px] w-[390px] overflow-hidden rounded-[28px] border border-border bg-bg text-fg shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The three directions.
   -------------------------------------------------------------------------- */

function SettingsColumnNav({
  active,
  onSelect,
  itemClassName,
  trailingIcon,
}: {
  active: string;
  onSelect: (id: string) => void;
  itemClassName?: string;
  /** A chevron on a phone, where each item opens its own page. */
  trailingIcon?: ReactNode;
}) {
  const item = (destination: Destination) => (
    <NavItem
      key={destination.id}
      href={`#${destination.id}`}
      onClick={(event) => {
        prevent(event);
        onSelect(destination.id);
      }}
      label={destination.label}
      active={active === destination.id}
      trailingIcon={trailingIcon}
      className={itemClassName}
    />
  );
  return (
    <>
      <NavGroup>{SETTINGS.map(item)}</NavGroup>
      <NavGroup label="Runtime">{RUNTIME.map(item)}</NavGroup>
    </>
  );
}

function OrganizationLink({ size }: { size?: NavItemSize }) {
  return (
    <NavGroup label="Organization">
      <NavItem
        href="#organization"
        onClick={prevent}
        label={organization.name}
        icon={<Building2Icon />}
        trailingIcon={<ArrowRightIcon />}
        size={size}
      />
    </NavGroup>
  );
}

/** A: the rail never swaps; settings has its own 200px column in the content. */
function SubNavInContent() {
  const [page, setPage] = useState("general");
  return (
    <AppWindow label="Settings with the sub-nav inside the content">
      <MainRail active="settings" />
      <div className="flex min-w-0 flex-1 gap-10 overflow-hidden px-10 pt-8">
        <SettingsNav
          aria-label="Workspace settings"
          header={
            <div className="px-2.5">
              <p className="text-sm leading-5 font-semibold text-fg">Settings</p>
              <p className="truncate text-xs leading-4.5 text-fg-subtle">{currentWorkspace.name}</p>
            </div>
          }
          footer={<OrganizationLink />}
        >
          <SettingsColumnNav active={page} onSelect={setPage} />
        </SettingsNav>
        <div className="max-w-[720px] min-w-0 flex-1">
          <SettingsPageContent page={page} />
        </div>
      </div>
    </AppWindow>
  );
}

/** B: the settings rail replaces the main rail, cleaned up. */
function CleanedSettingsRail() {
  const [page, setPage] = useState("general");
  const item = (destination: Destination) => {
    const Icon = destination.icon;
    return (
      <NavItem
        key={destination.id}
        href={`#${destination.id}`}
        onClick={(event) => {
          prevent(event);
          setPage(destination.id);
        }}
        icon={<Icon />}
        label={destination.label}
        active={page === destination.id}
        size="comfortable"
      />
    );
  };
  return (
    <AppWindow label="Settings in a rail that replaces the main rail">
      <SettingsNav
        variant="rail"
        aria-label="Workspace settings"
        header={
          <div className="flex flex-col gap-3">
            <NavItem
              href="#back"
              onClick={prevent}
              icon={<ChevronLeftIcon />}
              label="Back to chats"
              size="comfortable"
            />
            <WorkspaceSwitcher />
          </div>
        }
        footer={<OrganizationLink size="comfortable" />}
      >
        <NavGroup>{SETTINGS.map(item)}</NavGroup>
        <NavGroup label="Runtime">{RUNTIME.map(item)}</NavGroup>
      </SettingsNav>
      <div className="min-w-0 flex-1 overflow-hidden px-14 pt-8">
        <div className="max-w-[760px]">
          <SettingsPageContent page={page} />
        </div>
      </div>
    </AppWindow>
  );
}

/** C: settings sections as page tabs under one "Settings" header. */
function SettingsAsTabs() {
  const [page, setPage] = useState("general");
  const picks = usePagePicks();
  return (
    <AppWindow label="Settings sections as page tabs">
      <MainRail active="settings" />
      <div className="min-w-0 flex-1 overflow-hidden px-10 pt-8">
        <div className="mx-auto max-w-[960px]">
          <PageHeaderStyleProvider variant={picks.headerVariant}>
            <PageHeader
              icon={<SettingsIcon />}
              title="Settings"
              description={`Everything about ${currentWorkspace.name}, in one place.`}
              actions={<PageActions page={page} />}
              tabs={
                <LineTabsNav
                  aria-label="Workspace settings"
                  trailing={
                    <NavItem
                      href="#organization"
                      onClick={prevent}
                      icon={<Building2Icon />}
                      label={organization.name}
                      trailingIcon={<ArrowRightIcon />}
                    />
                  }
                >
                  {ALL_SETTINGS.map((destination) => (
                    <LineTabsLink
                      key={destination.id}
                      href={`#${destination.id}`}
                      active={page === destination.id}
                      onClick={(event) => {
                        prevent(event);
                        setPage(destination.id);
                      }}
                    >
                      {destination.label}
                    </LineTabsLink>
                  ))}
                </LineTabsNav>
              }
            />
          </PageHeaderStyleProvider>
          <div className="mt-6">
            <PageBody page={page} variant={picks.section} />
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/* ----------------------------------------------------------------------------
   States.
   -------------------------------------------------------------------------- */

function ItemState({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[136px_minmax(0,240px)] items-center gap-4">
      <span className="text-xs leading-4.5 text-fg-subtle">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function NavItemStates() {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ItemState label="Default">
        <NavItem
          href="#schedules"
          onClick={prevent}
          icon={<CalendarClockIcon />}
          label="Schedules"
        />
      </ItemState>
      <ItemState label="Hover">
        <NavItem
          href="#schedules"
          onClick={prevent}
          icon={<CalendarClockIcon />}
          label="Schedules"
          className="bg-surface-2 text-fg"
        />
      </ItemState>
      <ItemState label="Active">
        <NavItem
          href="#schedules"
          onClick={prevent}
          icon={<CalendarClockIcon />}
          label="Schedules"
          active
        />
      </ItemState>
      <ItemState label="With count">
        <NavItem href="#for-you" onClick={prevent} icon={<SendIcon />} label="For you" badge="2" />
      </ItemState>
      <ItemState label="Needs you">
        <NavItem
          href="#knowledge"
          onClick={prevent}
          icon={<BrainCircuitIcon />}
          label="Knowledge"
          attention
          attentionLabel="3 waiting for review"
        />
      </ItemState>
      <ItemState label="Leaves this area">
        <NavItem
          href="#organization"
          onClick={prevent}
          icon={<Building2Icon />}
          label={organization.name}
          trailingIcon={<ArrowRightIcon />}
        />
      </ItemState>
      <ItemState label="Disabled with reason">
        <NavItem
          icon={<BarChart3Icon />}
          label="Insights"
          disabledReason="Only workspace admins can see Insights. Ask Maria Chen for access."
        />
      </ItemState>
      <ItemState label="Loading">
        <NavItemSkeleton width="w-20" />
      </ItemState>
    </div>
  );
}

function CollapsedRailPreview() {
  const [active, setActive] = useState("schedules");
  return (
    <div className="flex h-[460px] min-w-0 overflow-hidden rounded-[14px] border border-border bg-bg">
      <MainRail active={active} onSelect={setActive} collapsed />
      <div className="min-w-0 flex-1 px-6 pt-6">
        <PageHeader
          icon={<CalendarClockIcon />}
          title="Schedules"
          description="Recurring agent work in this workspace."
        />
      </div>
    </div>
  );
}

function MobileSheetPreview() {
  return (
    <PhoneFrame label="The main rail as a sheet on a phone">
      <div className="px-4 pt-14">
        <PageHeader
          icon={<CalendarClockIcon />}
          title="Schedules"
          description="Recurring agent work in this workspace."
          actions={
            <Button>
              <PlusIcon aria-hidden="true" />
              New schedule
            </Button>
          }
        />
      </div>
      <div aria-hidden="true" className="absolute inset-0 bg-black/50" />
      <div className="absolute inset-y-0 left-0 flex w-[296px] shadow-lg">
        <MainRail active="schedules" className="w-full bg-surface pt-11" />
      </div>
    </PhoneFrame>
  );
}

function MobileSettingsIndex() {
  const [page, setPage] = useState("");
  return (
    <PhoneFrame label="Settings index on a phone">
      <div className="px-4 pt-14">
        <PageHeader title="Settings" context={currentWorkspace.name} />
        <nav aria-label="Workspace settings" className="-mx-2.5 mt-4 flex flex-col gap-5">
          <SettingsColumnNav
            active={page}
            onSelect={setPage}
            itemClassName="h-11"
            trailingIcon={<ChevronRightIcon />}
          />
          <OrganizationLink />
        </nav>
      </div>
    </PhoneFrame>
  );
}

function MobileSettingsPage() {
  const picks = usePagePicks();
  return (
    <PhoneFrame label="A settings page on a phone">
      <div className="px-4 pt-14">
        <PageHeaderStyleProvider variant={picks.headerVariant} icon={picks.iconMode}>
          <PageHeader
            context={
              <a
                href="#settings"
                onClick={prevent}
                className="-ml-0.5 inline-flex items-center gap-0.5 rounded-md transition-colors hover:text-fg"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
                Settings
              </a>
            }
            icon={<SlidersHorizontalIcon />}
            title="General"
          />
        </PageHeaderStyleProvider>
        <div className="mt-6">
          <GeneralBody variant={picks.section} />
        </div>
      </div>
    </PhoneFrame>
  );
}

const longWorkspace = `${workspaces[1]!.name} - EU on-call and release tooling`;

export default function NavigationSection() {
  return (
    <KitSection sectionKey="navigation">
      <Fork
        layout="stack"
        description={
          <>
            We recommend A: people keep their place, and the two sidebars stop using two different
            label systems. The pages inside follow your Page header and Section picks.
          </>
        }
      >
        <Alternative id="a">
          <SubNavInContent />
        </Alternative>
        <Alternative id="b">
          <CleanedSettingsRail />
        </Alternative>
        <Alternative id="c">
          <SettingsAsTabs />
        </Alternative>
      </Fork>

      <StatesGrid columns={2} description="Version A. Click the items; they are the real NavItem.">
        <StateCell
          label="Nav item"
          align="stretch"
          note="32px, radius 10, 16px icon. 44px on touch."
        >
          <NavItemStates />
        </StateCell>

        <StateCell
          label="Collapsed rail"
          note="Icons only; hover or focus shows the name. Groups get a short hairline."
          align="stretch"
        >
          <CollapsedRailPreview />
        </StateCell>

        <StateCell
          label="Error"
          note="A list that fails says so in place; every destination above it keeps working."
          align="stretch"
        >
          <div className="flex w-60 min-w-0 flex-col gap-6">
            <NavGroup>
              <NavItem
                href="#schedules"
                onClick={prevent}
                icon={<CalendarClockIcon />}
                label="Schedules"
              />
              <NavItem
                href="#capabilities"
                onClick={prevent}
                icon={<PlugIcon />}
                label="Capabilities"
              />
            </NavGroup>
            <NavGroup label="Chats">
              <p
                role="status"
                className="flex min-w-0 items-center gap-2 px-2.5 text-xs leading-4.5 text-fg-muted"
              >
                <span className="min-w-0">Couldn't load chats.</span>
                <button
                  type="button"
                  className="shrink-0 rounded-sm font-medium text-brand transition-colors hover:text-fg"
                >
                  Try again
                </button>
              </p>
            </NavGroup>
          </div>
        </StateCell>

        <StateCell
          label="Long text"
          note="Labels truncate on one line; the switcher keeps its chevron."
          align="stretch"
        >
          <div className="flex w-60 min-w-0 flex-col gap-4">
            <WorkspaceSwitcher name={longWorkspace} />
            <NavGroup label="Runtime">
              <NavItem
                href="#sandbox-environments"
                onClick={prevent}
                icon={<ContainerIcon />}
                label="Sandbox environments for the EU region"
                active
              />
              <NavItem
                href="#machines"
                onClick={prevent}
                icon={<LaptopIcon />}
                label="Machines"
                badge="12"
              />
            </NavGroup>
            <OrganizationLink />
          </div>
        </StateCell>
      </StatesGrid>

      <StatesGrid
        title="On a phone"
        columns={3}
        description="390px wide. The rail becomes a sheet, and settings becomes a list of pages."
      >
        <StateCell label="The rail as a sheet" note="Swipe or tap outside to close.">
          <MobileSheetPreview />
        </StateCell>

        <StateCell
          label="Settings index"
          note="On a phone, the sub-nav is the Settings page itself."
        >
          <MobileSettingsIndex />
        </StateCell>

        <StateCell label="A settings page" note="A back link replaces the sub-nav.">
          <MobileSettingsPage />
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Destinations"
        description="One name and one icon per destination, used by the rail, the page title and the page header."
      >
        <ul className="grid min-w-0 gap-x-6 gap-y-1 @xl/kit-section:grid-cols-2 @4xl/kit-section:grid-cols-3">
          {[...RAIL, ...ALL_SETTINGS].map((item) => {
            const Icon = item.icon;
            return (
              <li
                key={item.id}
                className="flex min-w-0 items-center gap-2.5 py-1.5 text-sm text-fg"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="ml-auto shrink-0 text-xs text-fg-subtle">
                  {RAIL.includes(item) ? "Main rail" : "Settings"}
                </span>
              </li>
            );
          })}
        </ul>
      </KitBlock>

      <UsageNotes
        use={[
          "Every destination once, with one name and one icon. Rail label = page title = route noun.",
          "The main rail: New session, For you, Capabilities, Knowledge, Schedules, Artifacts, then Settings in the footer. Settings opens in the content area with its own sub-nav.",
          "Group labels in 12px sentence case, only when a group needs a name (Runtime, Chats).",
          "Hide destinations the viewer can't use. Disable only when access is on its way.",
          "A trailing arrow when the item leaves this area (Organization settings).",
        ]}
        avoid={[
          "Uppercase or stacked labels above groups.",
          "The same icon for two destinations.",
          "Actions in the nav, like Invite or New. They belong in page headers.",
          'Counts that the data can\'t back. Show a dot when only "something is waiting" is known.',
        ]}
      />
    </KitSection>
  );
}
