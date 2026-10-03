import { useState, type ReactNode } from "react";
import { BracesIcon } from "lucide-react";

import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { RelativeTime, type RelativeTimeProps } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";

import { KIT_NOW, KIT_TIME_ZONE, schedules, variableSets } from "../fixtures";
import { KitBlock, KitCanvas, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;
const MINUTE = 60_000;

function ago(ms: number): Date {
  return new Date(KIT_NOW.getTime() - ms);
}

interface Example {
  label: string;
  where: string;
  props: Omit<RelativeTimeProps, "now" | "timeZone">;
}

const RELATIVE: Example[] = [
  { label: "Under a minute", where: "Checked usage", props: { date: ago(20_000) } },
  { label: "Minutes", where: "Variable set created", props: { date: ago(18 * MINUTE) } },
  { label: "Hours", where: "API key last used", props: { date: ago(2 * 60 * MINUTE) } },
  { label: "Yesterday", where: "Schedule last run", props: { date: schedules[1]!.lastRun.at! } },
  { label: "Days", where: "Variable set updated", props: { date: variableSets[0]!.updatedAt } },
  { label: "Weeks", where: "Knowledge entry updated", props: { date: variableSets[2]!.updatedAt } },
  {
    label: "Months",
    where: "Organization set updated",
    props: { date: variableSets[4]!.updatedAt },
  },
  {
    label: "Future",
    where: "Invitation expires",
    props: { date: new Date(KIT_NOW.getTime() + 5 * 24 * 60 * MINUTE), prefix: "Expires" },
  },
];

const ABSOLUTE: Example[] = [
  {
    label: "Later today",
    where: "Next run",
    props: { date: schedules[0]!.nextRunAt!, format: "absolute" },
  },
  {
    label: "This week",
    where: "Next run",
    props: { date: schedules[1]!.nextRunAt!, format: "absolute" },
  },
  {
    label: "Next month",
    where: "Usage resets",
    props: { date: "2026-10-01T07:00:00Z", format: "absolute", prefix: "Resets" },
  },
  {
    label: "Another year",
    where: "Key expires",
    props: { date: "2027-03-31T10:00:00Z", format: "date", prefix: "Expires" },
  },
  {
    label: "Date only",
    where: "Variable changed",
    props: { date: "2026-08-14T10:02:00Z", format: "date" },
  },
  {
    label: "UTC",
    where: "Insights call log",
    props: { date: "2026-09-26T09:12:00Z", format: "absolute", utc: true },
  },
];

function ExampleTable({ title, examples }: { title: string; examples: Example[] }) {
  return (
    <KitCanvas padding={false}>
      <p className="border-b border-border px-5 py-3 text-xs leading-4.5 font-medium text-fg-muted">
        {title}
      </p>
      <dl className="m-0 divide-y divide-border">
        {examples.map((example) => (
          <div
            key={example.label}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-2.5"
          >
            <dt className="min-w-0">
              <span className="block truncate text-sm leading-5 text-fg">{example.label}</span>
              <span className="block truncate text-xs leading-4.5 text-fg-subtle">
                {example.where}
              </span>
            </dt>
            <dd className="m-0 text-right text-sm leading-5 text-fg-muted">
              <RelativeTime {...TIME} {...example.props} />
            </dd>
          </div>
        ))}
      </dl>
    </KitCanvas>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-5 text-fg-muted">{children}</p>;
}

export default function RelativeTimeSection() {
  const aws = variableSets[0]!;
  const failing = schedules[1]!;
  // Mounted once, so the live example ticks from "just now" to "1 min ago".
  const [openedAt] = useState(() => new Date());

  return (
    <KitSection sectionKey="relative-time">
      <KitBlock
        title="One set of formats"
        description={`Hover or focus any time for the exact moment. The kit's clock is Sat 26 Sep 2026, 13:48 Oslo time.`}
      >
        <div className="grid min-w-0 gap-4 @xl/kit-section:grid-cols-2">
          <ExampleTable title="Relative, for things that happened" examples={RELATIVE} />
          <ExampleTable title="Absolute, for things people plan around" examples={ABSOLUTE} />
        </div>
      </KitBlock>

      <KitBlock
        title="In context"
        description="Inside a list row the row is the tab stop; the time still shows its tooltip on hover and tap."
      >
        <KitCanvas>
          <RowList label="Variable sets">
            {variableSets.slice(0, 3).map((set) => (
              <ListRow
                key={set.id}
                leading={<LogoTile icon={<BracesIcon />} />}
                title={set.name}
                description={set.description}
                meta={[
                  set.variablesLabel,
                  <RelativeTime key="updated" date={set.updatedAt} prefix="Updated" {...TIME} />,
                ]}
                indicator="open"
                onOpen={() => {}}
              />
            ))}
          </RowList>
        </KitCanvas>
      </KitBlock>

      <StatesGrid columns={3}>
        <StateCell
          label="Sentence"
          note="Inside copy the leading word is lowercased: 'failed yesterday'."
        >
          <Line>
            {failing.name} failed <RelativeTime date={failing.lastRun.at!} inSentence {...TIME} />.
            Next run{" "}
            <RelativeTime date={failing.nextRunAt!} format="absolute" inSentence {...TIME} />.
          </Line>
        </StateCell>
        <StateCell label="With a status" note="Status first, then when, as one phrase.">
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <StatusBadge variant="dot" status="failed" />
            <RelativeTime date={failing.lastRun.at!} inSentence {...TIME} />
          </span>
        </StateCell>
        <StateCell
          label="Live"
          note="Without a fixed clock it updates every minute, from one shared timer."
        >
          <Line>
            <RelativeTime date={openedAt} prefix="Opened" />
          </Line>
        </StateCell>
        <StateCell label="Other time zones" note="The tooltip names the zone in words.">
          <Line>
            <RelativeTime
              date={aws.updatedAt}
              format="absolute"
              now={KIT_NOW}
              timeZone="America/Los_Angeles"
            />
          </Line>
        </StateCell>
        <StateCell
          label="No tooltip"
          note="For dense tables where the exact time is one click away."
        >
          <Line>
            <RelativeTime
              date={ago(2 * 60 * MINUTE)}
              prefix="Last used"
              tooltip={false}
              {...TIME}
            />
          </Line>
        </StateCell>
        <StateCell
          label="Unknown"
          note="An invalid date renders nothing instead of 'Invalid Date'."
        >
          {/* Terraform runner has no last-used time: the caller supplies "never". */}
          <Line>
            Last used <RelativeTime date="" {...TIME} />
            never
          </Line>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Relative for past events in lists: updated, last run, last used, joined.",
          "Absolute for future moments people plan around: next run, resets, expires.",
          "Date only when the time of day doesn't matter: expiry dates, created on.",
          "UTC only in Insights, where people compare times across zones.",
        ]}
        avoid={[
          "Seconds, ISO timestamps or 'a few seconds ago'.",
          "Mixing formats in one column.",
          "Relative times for moments people plan around, like a next run. Use the absolute format.",
          "Native title tooltips: they never show on touch or keyboard.",
        ]}
      />
    </KitSection>
  );
}
