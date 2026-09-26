import type { ReactNode } from "react";
import {
  BrainCircuitIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  MoreHorizontalIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  VariableIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { LineTabs, LineTabsList, LineTabsTrigger } from "@/components/ui/line-tabs";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import {
  PageHeader,
  PageHeaderStyleProvider,
  type PageHeaderVariant,
} from "@/components/ui/page-header";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { organization, reviewItems, schedules, variableSets } from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   Copy from the brief's sample content.
   -------------------------------------------------------------------------- */

const SCHEDULES = {
  title: "Schedules",
  description: "Recurring agent work in this workspace.",
  action: "New schedule",
};

const VARIABLE_SETS = {
  title: "Variable sets",
  description: "Environment variables and secrets your agents get in their sandbox.",
  action: "New variable set",
};

const PEOPLE = {
  title: "People",
  description: `Everyone in ${organization.name}. Each person has one organization role and a private Personal workspace.`,
  action: "Invite people",
};

const KNOWLEDGE = {
  title: "Knowledge",
  description: "What your agents know and how they learn.",
};

/* ----------------------------------------------------------------------------
   Small preview frames (kit-only compositions of real primitives).
   -------------------------------------------------------------------------- */

function FrameLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">{children}</p>;
}

/** A quiet list under the header, so the rhythm below the rule is visible. */
function PreviewRows({ rows }: { rows: Array<{ title: string; meta: string }> }) {
  return (
    <ul className="mt-4 flex min-w-0 flex-col" aria-label="Preview content">
      {rows.map((row) => (
        <li key={row.title} className="flex min-w-0 flex-col gap-0.5 py-2">
          <span className="truncate text-sm leading-5 font-medium text-fg">{row.title}</span>
          <span className="truncate text-xs leading-4.5 text-fg-subtle">{row.meta}</span>
        </li>
      ))}
    </ul>
  );
}

const scheduleRows = schedules.slice(0, 2).map((schedule) => ({
  title: schedule.name,
  meta: `${schedule.cadenceShortLabel} · Next run ${schedule.nextRunLabel}`,
}));

const variableSetRows = variableSets.slice(0, 2).map((set) => ({
  title: set.name,
  meta: `${set.variablesLabel} · ${set.usageLabel} · Updated ${set.updatedLabel}`,
}));

function MiniSettingsNav() {
  return (
    <SettingsNav aria-label="Workspace settings">
      <NavGroup>
        <NavItem href="#general" label="General" onClick={(event) => event.preventDefault()} />
        <NavItem href="#access" label="Access" onClick={(event) => event.preventDefault()} />
        <NavItem href="#models" label="Models" onClick={(event) => event.preventDefault()} />
      </NavGroup>
      <NavGroup label="Runtime">
        <NavItem
          href="#variable-sets"
          label="Variable sets"
          active
          onClick={(event) => event.preventDefault()}
        />
        <NavItem
          href="#sandbox-environments"
          label="Sandbox environments"
          onClick={(event) => event.preventDefault()}
        />
      </NavGroup>
    </SettingsNav>
  );
}

function RailPageFrame() {
  return (
    <div className="min-w-0">
      <FrameLabel>Main-rail page</FrameLabel>
      <div className="min-w-0 rounded-[14px] border border-border bg-bg px-4 pt-4 pb-1 @xl/kit-section:px-6 @xl/kit-section:pt-6 @xl/kit-section:pb-2">
        <PageHeader
          icon={<CalendarClockIcon />}
          title={SCHEDULES.title}
          description={SCHEDULES.description}
          actions={
            <Button>
              <PlusIcon aria-hidden="true" />
              {SCHEDULES.action}
            </Button>
          }
        />
        <PreviewRows rows={scheduleRows} />
      </div>
    </div>
  );
}

function SettingsPageFrame() {
  return (
    <div className="min-w-0">
      <FrameLabel>Settings page</FrameLabel>
      <div className="flex min-w-0 gap-8 rounded-[14px] border border-border bg-bg px-4 pt-4 pb-1 @xl/kit-section:px-6 @xl/kit-section:pt-6 @xl/kit-section:pb-2">
        <div className="hidden @3xl/kit-section:block">
          <MiniSettingsNav />
        </div>
        <div className="min-w-0 flex-1">
          <PageHeader
            icon={<VariableIcon />}
            title={VARIABLE_SETS.title}
            description={VARIABLE_SETS.description}
            actions={
              <Button>
                <PlusIcon aria-hidden="true" />
                {VARIABLE_SETS.action}
              </Button>
            }
          />
          <PreviewRows rows={variableSetRows} />
        </div>
      </div>
    </div>
  );
}

function HeaderPair({
  variant,
  settingsIcon,
}: {
  variant: PageHeaderVariant;
  settingsIcon: "show" | "hide";
}) {
  return (
    <PageHeaderStyleProvider variant={variant}>
      <div className="grid min-w-0 gap-5">
        <RailPageFrame />
        <PageHeaderStyleProvider icon={settingsIcon}>
          <SettingsPageFrame />
        </PageHeaderStyleProvider>
      </div>
    </PageHeaderStyleProvider>
  );
}

/* ----------------------------------------------------------------------------
   States (recommended version B: icon on main-rail pages, none in settings).
   -------------------------------------------------------------------------- */

function PrimaryButton({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <Button disabled={disabled}>
      <PlusIcon aria-hidden="true" />
      {children}
    </Button>
  );
}

function DisabledPrimary({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <DisabledReason reason={reason} side="bottom">
      <Button>
        <PlusIcon aria-hidden="true" />
        {children}
      </Button>
    </DisabledReason>
  );
}

function StateFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("w-full min-w-0", className)}>{children}</div>;
}

const pendingReviews = reviewItems.length;
const financeExports = variableSets.find((set) => set.scope === "organization") ?? variableSets[0]!;

/** Knowledge: two actions and a tab row with a "needs you" count. */
function KnowledgeHeader() {
  return (
    <LineTabs defaultValue="library">
      <PageHeader
        icon={<BrainCircuitIcon />}
        title={KNOWLEDGE.title}
        description={KNOWLEDGE.description}
        actions={
          <>
            <Button variant="outline">Learning: Review first</Button>
            <Button>
              <PlusIcon aria-hidden="true" />
              Add
              <ChevronDownIcon aria-hidden="true" className="-mr-0.5 size-3.5 opacity-80" />
            </Button>
          </>
        }
        tabs={
          <LineTabsList aria-label="Knowledge">
            <LineTabsTrigger value="library">Library</LineTabsTrigger>
            <LineTabsTrigger value="instructions">Instructions</LineTabsTrigger>
            <LineTabsTrigger
              value="review"
              count={pendingReviews}
              countTone="attention"
              countLabel={`${pendingReviews} waiting for review`}
            >
              Review
            </LineTabsTrigger>
          </LineTabsList>
        }
      />
    </LineTabs>
  );
}

/** The back link on detail pages, in the header's context line. */
function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => event.preventDefault()}
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-md text-fg-subtle transition-colors hover:text-fg"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      {children}
    </a>
  );
}

/** A user-written schedule name: long titles happen on detail pages. */
const LONG_SCHEDULE = {
  name: "Summarize failed deploys, flaky tests and open incidents for the platform on-call rotation",
  description: "Every weekday at 08:00 · Oslo · Posts to #platform-oncall in Slack.",
};

export default function PageHeaderSection() {
  return (
    <KitSection sectionKey="page-header">
      <Fork layout="stack">
        <Alternative id="a">
          <HeaderPair variant="default" settingsIcon="show" />
        </Alternative>
        <Alternative id="b">
          <HeaderPair variant="default" settingsIcon="hide" />
        </Alternative>
        <Alternative id="c">
          <HeaderPair variant="large" settingsIcon="hide" />
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="Version B. Settings pages are shown without the icon, main-rail pages with it."
      >
        <StateCell label="Plain" align="stretch">
          <StateFrame>
            <PageHeader icon={<PanelsTopLeftIcon />} title="Artifacts" />
          </StateFrame>
        </StateCell>

        <StateCell label="With description" align="stretch">
          <StateFrame>
            <PageHeader
              icon={<BrainCircuitIcon />}
              title={KNOWLEDGE.title}
              description={KNOWLEDGE.description}
            />
          </StateFrame>
        </StateCell>

        <StateCell span="full" label="With actions (settings page)" align="stretch">
          <StateFrame>
            <PageHeader
              title={VARIABLE_SETS.title}
              description={VARIABLE_SETS.description}
              actions={<PrimaryButton>{VARIABLE_SETS.action}</PrimaryButton>}
            />
          </StateFrame>
        </StateCell>

        <StateCell
          span="full"
          label="With context line"
          note="Organization scope sits above the title."
          align="stretch"
        >
          <StateFrame>
            <PageHeader
              context={organization.name}
              title={PEOPLE.title}
              description={PEOPLE.description}
              actions={<PrimaryButton>{PEOPLE.action}</PrimaryButton>}
            />
          </StateFrame>
        </StateCell>

        <StateCell
          label="With tabs"
          note="The tab row's rule replaces the header hairline."
          span="full"
          align="stretch"
        >
          <StateFrame>
            <KnowledgeHeader />
          </StateFrame>
        </StateCell>

        <StateCell span="full" label="Detail page with back link" align="stretch">
          <StateFrame>
            <PageHeader
              context={<BackLink href="#variable-sets">Variable sets</BackLink>}
              title={financeExports.name}
              meta={<MetaChip variant="outline">Organization</MetaChip>}
              description={financeExports.description}
              actions={
                <>
                  <Button variant="outline">
                    <PlusIcon aria-hidden="true" />
                    Add variable
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="More actions for Finance exports">
                    <MoreHorizontalIcon aria-hidden="true" />
                  </Button>
                </>
              }
            />
          </StateFrame>
        </StateCell>

        <StateCell
          span="full"
          label="Loading"
          note="The title never waits. Actions wait for permissions, at their final size."
          align="stretch"
        >
          <StateFrame>
            <PageHeader
              title={VARIABLE_SETS.title}
              description={VARIABLE_SETS.description}
              actions={
                <Skeleton
                  aria-label="Loading actions"
                  className="h-9 w-[164px] rounded-[10px] bg-surface-3"
                />
              }
            />
          </StateFrame>
        </StateCell>

        <StateCell
          span="full"
          label="Disabled with reason"
          note="Hover or focus the button: Only workspace admins can create variable sets."
          align="stretch"
        >
          <StateFrame>
            <PageHeader
              title={VARIABLE_SETS.title}
              description={VARIABLE_SETS.description}
              actions={
                <DisabledPrimary reason="Only workspace admins can create variable sets. Ask Maria Chen or Bendik Hansen.">
                  {VARIABLE_SETS.action}
                </DisabledPrimary>
              }
            />
          </StateFrame>
        </StateCell>

        <StateCell
          span="full"
          label="Error"
          note="The header stays; the failure sits below the rule with a way out."
          align="stretch"
        >
          <StateFrame>
            <PageHeader
              icon={<CalendarClockIcon />}
              title={SCHEDULES.title}
              description={SCHEDULES.description}
              actions={<PrimaryButton>{SCHEDULES.action}</PrimaryButton>}
            />
            <Notice
              tone="failed"
              className="mt-4"
              action={
                <Button variant="outline">
                  <RotateCcwIcon aria-hidden="true" />
                  Try again
                </Button>
              }
            >
              Couldn't load schedules. Check your connection and try again.
            </Notice>
          </StateFrame>
        </StateCell>

        <StateCell
          span="full"
          label="Long text"
          note="The title wraps; the actions keep their size and stay in the column."
          align="stretch"
        >
          <StateFrame>
            <PageHeader
              context={<BackLink href="#schedules">Schedules</BackLink>}
              title={LONG_SCHEDULE.name}
              description={LONG_SCHEDULE.description}
              actions={
                <>
                  <Button variant="outline">
                    <PlayIcon aria-hidden="true" />
                    Run now
                  </Button>
                  <Button>
                    <PencilIcon aria-hidden="true" />
                    Edit schedule
                  </Button>
                </>
              }
            />
          </StateFrame>
        </StateCell>

        <StateCell
          label="Mobile 390"
          note="Title once; the action moves under the description."
          width="mobile"
          align="stretch"
        >
          <PageHeader
            icon={<CalendarClockIcon />}
            title={SCHEDULES.title}
            description={SCHEDULES.description}
            actions={<PrimaryButton>{SCHEDULES.action}</PrimaryButton>}
          />
        </StateCell>

        <StateCell
          label="Mobile 390 with tabs"
          note="Actions wrap under the description; the tab row keeps one line."
          width="mobile"
          align="stretch"
        >
          <KnowledgeHeader />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Once per page, at the top of the content column.",
          "Title = the rail label = the route noun. Same icon as the rail entry.",
          "One primary action. Secondary actions go in a ⋯ menu or the detail page.",
          "The context line for organization scope, or a back link on detail pages.",
          "The tabs slot when the page has sections; the tab rule replaces the hairline.",
        ]}
        avoid={[
          "Inside sheets and dialogs. They have their own 18px title.",
          "Headings inside a page. Use Section.",
          "Descriptions longer than one line (about 90 characters).",
          "Hiding the primary action while an empty state shows the same button.",
        ]}
      />
    </KitSection>
  );
}
