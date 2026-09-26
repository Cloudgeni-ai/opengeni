import { useId, useState } from "react";

import {
  CadencePicker,
  TimeZoneSearch,
  describeCadence,
  normalizeCadenceRule,
  toScheduleSpec,
  type CadenceFrequency,
  type CadencePickerVariant,
  type CadenceRule,
  type CadenceValue,
} from "@/components/ui/cadence-picker";
import { KIT_NOW, KIT_TIME_ZONE, cadenceExamples, scheduleById, timeZones } from "../fixtures";
import {
  Alternative,
  Fork,
  KitBlock,
  KitCanvas,
  KitSection,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";

const awsCost = scheduleById("sched-aws-cost");
const accessReview = scheduleById("sched-access-review");

function valueOf(rule: CadenceRule, timeZone = KIT_TIME_ZONE): CadenceValue {
  return { rule: normalizeCadenceRule(rule, timeZone), timeZone };
}

/** One picker with its own state, labelled like the schedule form's "When" field. */
function CadenceDemo({
  initial,
  variant = "sentence",
  label = "When",
  frequencies,
  viewerTimeZone,
  disabledReason,
  onValue,
}: {
  initial: CadenceValue;
  variant?: CadencePickerVariant;
  label?: string;
  frequencies?: CadenceFrequency[];
  viewerTimeZone?: string;
  disabledReason?: string;
  onValue?: (value: CadenceValue) => void;
}) {
  const [value, setValue] = useState(initial);
  const labelId = useId();
  return (
    <div className="flex w-full max-w-[640px] min-w-0 flex-1 flex-col gap-2">
      {label ? (
        <span id={labelId} className="text-sm font-medium text-fg">
          {label}
        </span>
      ) : null}
      <CadencePicker
        aria-labelledby={label ? labelId : undefined}
        variant={variant}
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
        timeZones={timeZones}
        now={KIT_NOW}
        frequencies={frequencies}
        viewerTimeZone={viewerTimeZone}
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason}
      />
    </div>
  );
}

function SpecPreview() {
  const [value, setValue] = useState(valueOf(awsCost.cadence));
  const spec = toScheduleSpec(value.rule, { timeZone: value.timeZone, now: KIT_NOW });
  const description = describeCadence(value.rule, {
    timeZone: value.timeZone,
    timeZoneLabel: timeZones.find((zone) => zone.id === value.timeZone)?.label,
    timeZoneShortLabel: timeZones.find((zone) => zone.id === value.timeZone)?.shortLabel,
    now: KIT_NOW,
  });
  return (
    <div className="grid min-w-0 gap-6 @3xl/kit-section:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <CadenceDemo initial={value} onValue={setValue} />
      <dl className="flex min-w-0 flex-col gap-3 text-sm">
        <div className="min-w-0">
          <dt className="text-xs leading-4.5 text-fg-muted">List row</dt>
          <dd className="text-fg">{description.short}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs leading-4.5 text-fg-muted">Detail sheet</dt>
          <dd className="text-fg">{description.sentence}.</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs leading-4.5 text-fg-muted">Saved as</dt>
          <dd>
            <pre className="mt-1 overflow-x-auto rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-xs leading-4.5 text-fg">
              {JSON.stringify(spec, null, 2)}
            </pre>
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function CadencePickerSection() {
  const aws = valueOf(awsCost.cadence);
  return (
    <KitSection sectionKey="cadence-picker">
      <Fork layout="stack">
        <Alternative id="a" canvas="surface">
          <CadenceDemo initial={aws} variant="sentence" />
        </Alternative>
        <Alternative id="b" canvas="surface">
          <CadenceDemo initial={aws} variant="presets" />
        </Alternative>
        <Alternative id="c" canvas="surface">
          <CadenceDemo initial={aws} variant="text" />
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="The sentence builder with every frequency, plus the states that need a word. All previews use the kit clock: Sat 26 Sep, 13:48 in Oslo."
      >
        <StateCell label="Every hour" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf({ frequency: "hourly" })} />
        </StateCell>
        <StateCell label="Every day" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf({ frequency: "daily", time: "07:30" })} />
        </StateCell>
        <StateCell label="Every weekday" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf(cadenceExamples.weekdays.rule)} />
        </StateCell>
        <StateCell label="Every week on chosen days" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf(cadenceExamples.weekly.rule)} />
        </StateCell>
        <StateCell label="Every month on day 1" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf(accessReview.cadence)} />
        </StateCell>
        <StateCell
          label="Every month on day 31"
          note="A true calendar day. Months without it are skipped, and the picker says so."
          align="stretch"
          canvas="surface"
        >
          <CadenceDemo
            label=""
            initial={valueOf({ frequency: "monthly", dayOfMonth: 31, time: "18:00" })}
          />
        </StateCell>
        <StateCell label="Custom interval" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf(cadenceExamples.interval.rule)} />
        </StateCell>
        <StateCell label="Every few days at a time" align="stretch" canvas="surface">
          <CadenceDemo
            label=""
            initial={valueOf({ frequency: "interval", every: 2, unit: "days", time: "08:00" })}
          />
        </StateCell>
        <StateCell label="One time" align="stretch" canvas="surface">
          <CadenceDemo label="" initial={valueOf(cadenceExamples.once.rule)} />
        </StateCell>
        <StateCell label="One time in the past" align="stretch" canvas="surface">
          <CadenceDemo
            label=""
            initial={valueOf({ frequency: "once", date: "2026-09-25", time: "08:00" })}
          />
        </StateCell>
        <StateCell label="Invalid" align="stretch" canvas="surface">
          <CadenceDemo
            label=""
            initial={valueOf({ frequency: "weekly", days: [], time: "09:30" })}
          />
        </StateCell>
        <StateCell
          label="Someone in another zone"
          note="Maria reads a schedule set in Oslo time from London."
          align="stretch"
          canvas="surface"
        >
          <CadenceDemo
            label=""
            initial={valueOf(cadenceExamples.weekdays.rule)}
            viewerTimeZone="Europe/London"
          />
        </StateCell>
        <StateCell
          label="Time zone search open"
          note="Suggested zones first; typing searches every zone."
          align="stretch"
          canvas="surface"
        >
          <div className="flex w-full max-w-80 flex-col overflow-hidden rounded-[16px] border border-border bg-surface shadow-og-md">
            <TimeZoneSearch
              value="Europe/Oslo"
              timeZones={timeZones}
              now={KIT_NOW}
              initialQuery="new"
              preview
              onSelect={() => undefined}
            />
          </div>
        </StateCell>
        <StateCell label="Disabled with reason" align="stretch" canvas="surface">
          <CadenceDemo
            label=""
            initial={valueOf(accessReview.cadence)}
            disabledReason="Only Maria Chen can change when this runs. You can pause it or duplicate it."
          />
        </StateCell>
        <StateCell
          label="Fewer frequencies"
          note="Knowledge source sync only offers hourly, daily and weekly."
          align="stretch"
          canvas="surface"
        >
          <CadenceDemo
            label="Sync"
            initial={valueOf({ frequency: "daily", time: "06:00" })}
            frequencies={["hourly", "daily", "weekly"]}
          />
        </StateCell>
        <StateCell label="Long text" align="stretch" canvas="surface">
          <CadenceDemo
            label=""
            initial={valueOf(
              { frequency: "weekly", days: ["mon", "tue", "wed", "thu", "sat"], time: "06:45" },
              "America/Argentina/Buenos_Aires",
            )}
          />
        </StateCell>
        <StateCell label="Mobile 390" width="mobile" align="stretch" canvas="surface" span="full">
          <CadenceDemo initial={valueOf(cadenceExamples.weekly.rule)} />
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="What it saves"
        description="The picker emits the rule and its time zone. The same rule gives the row label, the sheet sentence and the API spec. Monthly needs one small contract addition (daysOfMonth), which Temporal already supports."
      >
        <KitCanvas canvas="surface">
          <SpecPreview />
        </KitCanvas>
      </KitBlock>

      <UsageNotes
        use={[
          "Saying when something runs: schedules, knowledge source sync",
          "Any recurring rule where the time zone matters to the people reading it",
        ]}
        avoid={[
          "Picking a single date for something that isn't a run (use a date field)",
          "Filters over time ranges (use a segmented control: Today | 7 days | Month)",
        ]}
      >
        Show the same rule elsewhere with <code className="font-mono text-xs">describeCadence</code>
        : rows use the short label, sheets use the sentence.
      </UsageNotes>
    </KitSection>
  );
}
