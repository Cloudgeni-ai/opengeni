import { useEffect, useRef, useState, type ReactNode } from "react";
import { LayoutGridIcon, ListIcon } from "lucide-react";
import { toast } from "sonner";
import {
  SegmentedControl,
  type SegmentedControlOption,
  type SegmentedControlProps,
} from "@/components/ui/segmented-control";
import { SettingRow } from "@/components/ui/setting-row";
import {
  codexProvider,
  learningModes,
  learningSettings,
  organization,
  peopleCounts,
  type LearningMode,
} from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { usePick } from "../picks";
import { alternativeLetter, type AlternativeId } from "./registry";

/* ----------------------------------------------------------------------------
   Versions map onto real SegmentedControl props, and every version gets the
   same content.
   -------------------------------------------------------------------------- */

type VersionProps = Pick<SegmentedControlProps, "variant">;

const VERSION_PROPS: Record<AlternativeId, VersionProps> = {
  a: { variant: "filled" },
  b: { variant: "outlined" },
  c: { variant: "underline" },
};

type PeopleFilter = "all" | "invited" | "suspended";
type Rotation = typeof codexProvider.rotation;
type Source = typeof codexProvider.source;
type Range = "today" | "7d" | "month";
type View = "grid" | "list";

const LEARNING_OPTIONS: SegmentedControlOption<LearningMode>[] = learningModes.map((mode) => ({
  value: mode.id,
  label: mode.label,
}));

const PEOPLE_OPTIONS: SegmentedControlOption<PeopleFilter>[] = [
  { value: "all", label: "All", count: peopleCounts.all },
  { value: "invited", label: "Invited", count: peopleCounts.invited },
  { value: "suspended", label: "Suspended", count: peopleCounts.suspended },
];

const ROTATION_OPTIONS = codexProvider.rotationOptions.map((option) => ({
  value: option.id as Rotation,
  label: option.label,
}));

const RANGE_OPTIONS: SegmentedControlOption<Range>[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "month", label: "Month" },
];

const VIEW_OPTIONS: SegmentedControlOption<View>[] = [
  { value: "grid", label: "Grid", icon: <LayoutGridIcon />, iconOnly: true },
  { value: "list", label: "List", icon: <ListIcon />, iconOnly: true },
];

const SOURCE_REASON = `${organization.name} hasn't assigned a Codex account to this workspace. Ask an organization admin.`;

function sourceOptions(organizationAvailable: boolean): SegmentedControlOption<Source>[] {
  return codexProvider.sourceOptions.map((option) => ({
    value: option.id as Source,
    label: option.label,
    disabled: option.id === "organization" && !organizationAvailable,
    disabledReason: option.id === "organization" ? SOURCE_REASON : undefined,
  }));
}

/** A small caption and one control, the way each appears in the product. */
function Example({
  caption,
  where,
  children,
}: {
  caption: string;
  where: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs leading-4.5 text-fg-muted">
        <span className="font-medium text-fg">{caption}</span>
        <span className="text-fg-subtle"> · {where}</span>
      </p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Examples({ version }: { version: VersionProps }) {
  const [learning, setLearning] = useState<LearningMode>(learningSettings.shared.instructions);
  const [people, setPeople] = useState<PeopleFilter>("all");
  const [rotation, setRotation] = useState<Rotation>(codexProvider.rotation);
  const [range, setRange] = useState<Range>("7d");
  const [view, setView] = useState<View>("list");
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Example caption="Workspace instructions" where="Learning">
        <SegmentedControl
          {...version}
          aria-label="Workspace instructions"
          options={LEARNING_OPTIONS}
          value={learning}
          onValueChange={setLearning}
        />
      </Example>
      <Example caption="People" where="filter with counts">
        <SegmentedControl
          {...version}
          aria-label="Show people"
          options={PEOPLE_OPTIONS}
          value={people}
          onValueChange={setPeople}
        />
      </Example>
      <Example caption="Account selection" where="Codex">
        <SegmentedControl
          {...version}
          aria-label="Account selection"
          options={ROTATION_OPTIONS}
          value={rotation}
          onValueChange={setRotation}
        />
      </Example>
      <Example caption="Range and view" where="Insights, Artifacts">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            {...version}
            size="sm"
            aria-label="Range"
            options={RANGE_OPTIONS}
            value={range}
            onValueChange={setRange}
          />
          <SegmentedControl
            {...version}
            size="sm"
            aria-label="View"
            options={VIEW_OPTIONS}
            value={view}
            onValueChange={setView}
          />
        </div>
      </Example>
    </div>
  );
}

/** Saves on change: a spinner in the new option, then a toast. */
function SavingExample({ version }: { version: VersionProps }) {
  const [value, setValue] = useState<LearningMode>(learningSettings.shared.knowledge);
  const [pending, setPending] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <SegmentedControl
      {...version}
      aria-label="Knowledge"
      options={LEARNING_OPTIONS}
      value={value}
      pending={pending}
      onValueChange={(next) => {
        setValue(next);
        setPending(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setPending(false);
          const label = learningModes.find((mode) => mode.id === next)?.label ?? next;
          toast.success(`Knowledge learning set to ${label}`);
        }, 900);
      }}
    />
  );
}

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

export default function SegmentedControlSection() {
  const pick = usePick("segmented-control");
  const version = VERSION_PROPS[pick];
  return (
    <KitSection sectionKey="segmented-control">
      <Fork>
        {(["a", "b", "c"] as const).map((id) => (
          <Alternative key={id} id={id}>
            <Examples version={VERSION_PROPS[id]} />
          </Alternative>
        ))}
      </Fork>

      <StatesGrid
        columns={3}
        description={`Shown in version ${alternativeLetter(pick)}, your pick or the recommended one. Arrow keys move between options; Enter or Space picks one.`}
      >
        <StateCell
          label="Default, hover, active"
          note="Hover an option. Pick one: it saves, then confirms with a toast."
        >
          <SavingExample version={version} />
        </StateCell>
        <StateCell label="Disabled option" note="Hover, focus or tap Organization for the reason.">
          <SegmentedControl
            {...version}
            aria-label="Use subscriptions from"
            options={sourceOptions(false)}
            defaultValue="workspace"
          />
        </StateCell>
        <StateCell label="With counts" note="Counts are 11px, after the label.">
          <SegmentedControl
            {...version}
            aria-label="Show people"
            options={PEOPLE_OPTIONS}
            defaultValue="invited"
          />
        </StateCell>
        <StateCell
          label="Saving"
          note="The new option shows a spinner while it saves. Nothing around it moves."
        >
          <SegmentedControl
            {...version}
            aria-label="Knowledge"
            options={LEARNING_OPTIONS}
            defaultValue="review_first"
            pending
          />
        </StateCell>
        <StateCell
          label="Read only"
          note="Only workspace admins can change learning. Say so in the row."
        >
          <SegmentedControl
            {...version}
            aria-label="Skills"
            options={LEARNING_OPTIONS}
            defaultValue="review_first"
            disabled
          />
        </StateCell>
        <StateCell
          label="Small, with icons"
          note="32px, for setting rows and toolbars. Icon-only options keep a text name."
        >
          <div className="flex flex-wrap items-center justify-center gap-3">
            <SegmentedControl
              {...version}
              size="sm"
              aria-label="Range"
              options={RANGE_OPTIONS}
              defaultValue="today"
            />
            <SegmentedControl
              {...version}
              size="sm"
              aria-label="View"
              options={VIEW_OPTIONS}
              defaultValue="grid"
            />
          </div>
        </StateCell>
        <StateCell
          label="Long text"
          span={2}
          align="stretch"
          note="Two words at most. Longer choices need choice cards; five or more need a select."
        >
          <SettingRow
            label="Use subscriptions from"
            description={`Organization uses the Codex accounts ${organization.name} assigns to this workspace. This workspace uses only accounts connected here.`}
            controlWidth="auto"
            control={
              <SegmentedControl
                {...version}
                size="sm"
                options={sourceOptions(true)}
                defaultValue="workspace"
              />
            }
          />
        </StateCell>
        <StateCell
          label="Mobile 390"
          width="mobile"
          align="stretch"
          note="In a narrow row the options fill the width."
        >
          <SettingRow
            label="Knowledge"
            description="Facts, decisions and runbooks agents learn from shared chats."
            controlWidth="auto"
            control={
              <SegmentedControl
                {...version}
                size="sm"
                options={LEARNING_OPTIONS}
                defaultValue="automatic"
              />
            }
          />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "2 to 4 short options that stay visible: Automatic | Review first | Off",
          "Filters and views: All | Invited | Suspended, Today | 7 days | Month, Grid | List",
          "A setting that saves on change, inside a setting row",
        ]}
        avoid={[
          "5 or more options, or labels longer than two words: use a select",
          "Options that need a sentence each: use choice cards",
          "Moving between page sections: use tabs",
          "Plain on or off: use a switch",
        ]}
      />
    </KitSection>
  );
}
