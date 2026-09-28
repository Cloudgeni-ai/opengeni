import { useState, type ReactNode } from "react";
import {
  BracesIcon,
  CalendarClockIcon,
  GitPullRequestIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  SunriseIcon,
  TrendingUpIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateLink,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@/components/ui/empty-state";
import { ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";

import { scheduleTemplates, you } from "../fixtures";
import {
  Alternative,
  Fork,
  KitSection,
  PagePreview,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  "template-morning-brief": <SunriseIcon />,
  "template-dependency-pr": <GitPullRequestIcon />,
  "template-cost-anomaly": <TrendingUpIcon />,
};

const SCHEDULES_DESCRIPTION = "Recurring agent work in this workspace.";
const EMPTY_SCHEDULES =
  "Have the agent do something on a rhythm, like a morning brief or a weekly dependency PR.";

function NewScheduleButton() {
  return (
    <Button type="button" className="pointer-coarse:h-11">
      <PlusIcon />
      New schedule
    </Button>
  );
}

/** A page frame: header on top, the empty state below. */
function SchedulesFrame({
  headerAction,
  children,
}: {
  /** The header's primary action. Hidden while a centered empty state shows it. */
  headerAction?: boolean;
  children: ReactNode;
}) {
  return (
    <PagePreview label="Schedules, empty">
      <div className="mx-auto w-full max-w-[960px] min-w-0 px-8 pt-6 pb-4 max-sm:px-4">
        <PageHeader
          title="Schedules"
          description={SCHEDULES_DESCRIPTION}
          icon={<CalendarClockIcon />}
          actions={headerAction ? <NewScheduleButton /> : undefined}
        />
        {children}
      </div>
    </PagePreview>
  );
}

function ScheduleTemplates({ onPick }: { onPick: (name: string) => void }) {
  return (
    <EmptyStateTemplates>
      {scheduleTemplates.map((template) => (
        <EmptyStateTemplate
          key={template.id}
          icon={TEMPLATE_ICONS[template.id]}
          title={template.name}
          description={template.description}
          meta={template.cadenceLabel}
          onSelect={() => onPick(template.name)}
        />
      ))}
    </EmptyStateTemplates>
  );
}

function TemplatesAlternative() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SchedulesFrame>
        <EmptyState
          variant="page"
          icon={<CalendarClockIcon />}
          title="No schedules yet"
          description={EMPTY_SCHEDULES}
          action={<NewScheduleButton />}
          templates={<ScheduleTemplates onPick={setPicked} />}
        />
      </SchedulesFrame>
      <p role="status" className="min-h-4.5 text-xs leading-4.5 text-fg-subtle">
        {picked
          ? `${picked}: opens New schedule with the instructions and cadence filled in.`
          : "A template opens New schedule with its instructions and cadence filled in."}
      </p>
    </div>
  );
}

export default function EmptyStateSection() {
  return (
    <KitSection sectionKey="empty-state">
      <Fork layout="stack">
        <Alternative id="a">
          <SchedulesFrame>
            <EmptyState
              variant="page"
              icon={<CalendarClockIcon />}
              title="No schedules yet"
              description={EMPTY_SCHEDULES}
              action={<NewScheduleButton />}
            />
          </SchedulesFrame>
        </Alternative>
        <Alternative
          id="b"
          rationale="One muted sentence. The header keeps New schedule, so the page still has one action. With a link, the same line covers sections and no results."
        >
          <SchedulesFrame headerAction>
            <EmptyState
              variant="inline"
              className="mt-2"
              title="No schedules yet."
              description="Have the agent do something on a rhythm, like a morning brief."
            />
          </SchedulesFrame>
        </Alternative>
        <Alternative id="c">
          <TemplatesAlternative />
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="The recommended centered empty state (A), and where the inline one fits."
      >
        <StateCell label="Page" align="stretch">
          <EmptyState
            variant="page"
            className="pt-8 pb-6"
            icon={<BracesIcon />}
            title="No variable sets yet"
            description="Store the API keys and config your agents need, like AWS or GitHub tokens."
            action={
              <Button type="button" className="pointer-coarse:h-11">
                <PlusIcon />
                New variable set
              </Button>
            }
          />
        </StateCell>
        <StateCell
          label="Unavailable"
          note="Says who can fix it. No action the viewer can't take."
          align="stretch"
        >
          <EmptyState
            variant="page"
            className="pt-8 pb-6"
            icon={<KeyRoundIcon />}
            title="Only workspace admins can create API keys"
            description={`Ask ${you.name} for a key, or to make you a workspace admin in Design preview.`}
          />
        </StateCell>
        <StateCell
          label="Inline in a section"
          note="Inside a sheet or a page section."
          align="stretch"
          canvas="surface"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm leading-5 font-semibold text-fg">Variables</p>
            <EmptyState
              variant="inline"
              title="No variables yet."
              description={
                <>
                  <EmptyStateLink>Add a variable</EmptyStateLink> or{" "}
                  <EmptyStateLink>paste a .env file</EmptyStateLink>.
                </>
              }
            />
            <p className="mt-3 text-sm leading-5 font-semibold text-fg">Used by</p>
            <EmptyState
              variant="inline"
              title="Not used yet."
              description="Turn it on from the chat composer or a schedule."
            />
          </div>
        </StateCell>
        <StateCell
          label="No results"
          note="Quotes the search and clears it in one click."
          align="stretch"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex h-11 min-w-0 items-center rounded-[14px] border border-border bg-surface px-4 text-sm text-fg">
              aws
            </div>
            <EmptyState
              variant="inline"
              title={<>No matches for &ldquo;aws&rdquo;.</>}
              action={<EmptyStateLink>Clear search</EmptyStateLink>}
            />
          </div>
        </StateCell>
        <StateCell label="Couldn't load" note="What happened and what to do." align="stretch">
          <EmptyState
            variant="page"
            tone="danger"
            className="pt-8 pb-6"
            icon={<CalendarClockIcon />}
            title="Couldn't load schedules"
            description="Check your connection and try again. Nothing was changed."
            action={
              <Button type="button" variant="outline" className="pointer-coarse:h-11">
                <RefreshCwIcon />
                Try again
              </Button>
            }
          />
        </StateCell>
        <StateCell
          label="Loading"
          note="Never flash the empty state while the list loads."
          align="stretch"
        >
          <RowList label="Schedules" busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </StateCell>
        <StateCell
          label="Long text"
          note="The sentence wraps at 380px and stays centred."
          align="stretch"
        >
          <EmptyState
            variant="page"
            className="pt-8 pb-6"
            icon={<BracesIcon />}
            title="No organization variable sets are shared with Design preview yet"
            description="Organization admins can share variable sets with every workspace in Acme Robotics, or pick workspaces one by one in Organization settings."
          />
        </StateCell>
        <StateCell
          label="Mobile 390"
          width="mobile"
          note="Templates stack; the action stays full size."
          align="stretch"
        >
          <EmptyState
            variant="page"
            className="pt-8 pb-2"
            icon={<CalendarClockIcon />}
            title="No schedules yet"
            description={EMPTY_SCHEDULES}
            action={<NewScheduleButton />}
            templates={<ScheduleTemplates onPick={() => {}} />}
          />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "A list with nothing in it yet: say what goes here and offer the first action, once (A).",
          "Sections, sheets and searches with no results: one sentence and a link (B).",
          "Where starting is the hard part, like Schedules: 2-3 templates that prefill the form (C).",
        ]}
        avoid={[
          "The page header's primary action and the empty state's action at the same time.",
          "Dashed boxes, illustrations or apologies.",
          "Showing the empty state while the list is still loading.",
          "Features this deployment can't run: hide them, or say who can turn them on.",
        ]}
      />
    </KitSection>
  );
}
