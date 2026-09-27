import { useState } from "react";

import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DetailFact, DetailFacts } from "@/components/ui/detail-sheet";
import { Disclosure, type DisclosureVariant } from "@/components/ui/disclosure";
import { Field, FieldStack, TextArea } from "@/components/ui/field";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { learningModes, sandboxEnvironments, scheduleById } from "../fixtures";
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

/* ----------------------------------------------------------------------------
   The schedule's Advanced options, from the fixtures.
   -------------------------------------------------------------------------- */

const sentry = scheduleById("sched-sentry");

type EachRun = "new_chat" | "ongoing_chat";
type IfRunning = "queue" | "skip";

const whereOptions: SelectOption[] = [
  {
    value: "managed",
    label: "Managed sandbox",
    description: "A fresh OpenGeni sandbox for each run.",
  },
  ...sandboxEnvironments.map((environment) => ({
    value: environment.id,
    label: environment.name,
    meta: environment.isDefault ? "Default" : undefined,
    description: environment.description,
  })),
];

const learningOptions: SelectOption[] = [
  {
    value: "workspace",
    label: "Workspace learning defaults",
    description: "Knowledge automatic, instructions and skills review first.",
  },
  ...learningModes.map((mode) => ({
    value: mode.id,
    label: mode.label,
    description:
      mode.id === "automatic"
        ? "Saves what it learns right away."
        : mode.id === "review_first"
          ? "Suggestions wait in Review until someone approves them."
          : "Learns nothing from these runs.",
  })),
];

const ifRunningOptions: SelectOption<IfRunning>[] = [
  { value: "queue", label: "Queue the next run", description: "It starts when this one ends." },
  { value: "skip", label: "Skip the next run", description: "Nothing runs until the next time." },
];

interface AdvancedValues {
  eachRun: EachRun;
  ifRunning: IfRunning;
  where: string;
  learning: string;
}

const SENTRY_DEFAULTS: AdvancedValues = {
  eachRun: sentry.setup.eachRun,
  ifRunning: "queue",
  where: "managed",
  learning: "workspace",
};

function summarize(values: AdvancedValues): string {
  const label = (options: SelectOption[], value: string) =>
    options.find((option) => option.value === value)?.label ?? value;
  return [
    values.eachRun === "new_chat"
      ? "New chat each run"
      : `One ongoing chat, ${values.ifRunning === "skip" ? "skip" : "queue"} if still running`,
    label(whereOptions, values.where),
    label(learningOptions, values.learning),
  ].join(" · ");
}

function AdvancedFields({
  values,
  onChange,
}: {
  values: AdvancedValues;
  onChange: (values: AdvancedValues) => void;
}) {
  return (
    <FieldStack>
      <ChoiceCards
        label="Each run"
        value={values.eachRun}
        onValueChange={(eachRun) => onChange({ ...values, eachRun: eachRun as EachRun })}
      >
        <ChoiceCard
          value="new_chat"
          title="New chat"
          description="Every run starts fresh. Earlier runs stay in their own chats."
        />
        <ChoiceCard
          value="ongoing_chat"
          title="One ongoing chat"
          description="Each run continues the same chat, so the agent remembers earlier runs."
        />
      </ChoiceCards>
      {values.eachRun === "ongoing_chat" ? (
        <Field label="If the previous run is still working">
          <SelectMenu
            options={ifRunningOptions}
            value={values.ifRunning}
            onValueChange={(ifRunning) => onChange({ ...values, ifRunning })}
          />
        </Field>
      ) : null}
      <Field label="Where it runs">
        <SelectMenu
          options={whereOptions}
          value={values.where}
          onValueChange={(where) => onChange({ ...values, where })}
        />
      </Field>
      <Field label="Agent learning">
        <SelectMenu
          options={learningOptions}
          value={values.learning}
          onValueChange={(learning) => onChange({ ...values, learning })}
        />
      </Field>
    </FieldStack>
  );
}

/** The part of the schedule form above Advanced. */
function FormContext() {
  return (
    <FieldStack>
      <Field label="What should the agent do?">
        <TextArea defaultValue={sentry.instructions} rows={3} />
      </Field>
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">When</p>
        <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
          {sentry.cadenceSentence} Next run {sentry.nextRunLabel.toLowerCase()}.
        </p>
      </div>
    </FieldStack>
  );
}

function ForkDemo({ variant }: { variant: DisclosureVariant }) {
  const [values, setValues] = useState<AdvancedValues>(SENTRY_DEFAULTS);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FormContext />
      <Disclosure
        variant={variant}
        title="Advanced"
        summary={summarize(values)}
        sheetTitle="Advanced"
        sheetDescription={sentry.name}
      >
        <AdvancedFields values={values} onChange={setValues} />
      </Disclosure>
      {variant === "sheet" ? (
        <p className="text-xs leading-4.5 text-fg-subtle">
          Retired with the side sheets. The same row sits on the schedule&apos;s page, so these
          options can change after it&apos;s created.
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Technical details, the other everyday use.
   -------------------------------------------------------------------------- */

const posthogDetails: Array<{ label: string; value: string; mono?: boolean }> = [
  { label: "Endpoint", value: "https://mcp.posthog.com/mcp", mono: true },
  { label: "Connection ID", value: "conn_7f3a9c214e", mono: true },
  { label: "Scopes", value: "Read insights, read feature flags, read sessions" },
];

/** PostHog's Technical details, at the end of its connection page. */
function TechnicalDetails({ defaultOpen }: { defaultOpen?: boolean }) {
  return (
    <Disclosure
      className="@container/detail"
      title="Technical details"
      summary="Endpoint, connection ID and scopes"
      defaultOpen={defaultOpen}
    >
      <DetailFacts>
        {posthogDetails.map((row) => (
          <DetailFact key={row.label} label={row.label}>
            {row.mono ? (
              <span className="font-mono text-xs leading-4.5 break-all">{row.value}</span>
            ) : (
              row.value
            )}
          </DetailFact>
        ))}
      </DetailFacts>
    </Disclosure>
  );
}

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

function StatefulAdvanced(props: {
  defaultOpen?: boolean;
  values?: AdvancedValues;
  triggerClassName?: string;
}) {
  const [values, setValues] = useState<AdvancedValues>(props.values ?? SENTRY_DEFAULTS);
  return (
    <Disclosure
      title="Advanced"
      summary={summarize(values)}
      defaultOpen={props.defaultOpen}
      triggerClassName={props.triggerClassName}
    >
      <AdvancedFields values={values} onChange={setValues} />
    </Disclosure>
  );
}

export default function DisclosureSection() {
  return (
    <KitSection sectionKey="disclosure">
      <Fork description="We recommend A: it shows what is inside before you open it, and one pattern replaces four. Each version holds the same Advanced options of a schedule; open them to compare.">
        <Alternative id="a" canvas="surface">
          <ForkDemo variant="row" />
        </Alternative>
        <Alternative id="b" canvas="surface">
          <ForkDemo variant="inline" />
        </Alternative>
        <Alternative id="c" canvas="surface">
          <ForkDemo variant="sheet" />
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="The recommended version, A. Focus and hover are drawn on the row so they show without a pointer."
      >
        <StateCell label="Closed, with summary" canvas="surface" align="stretch">
          <StatefulAdvanced />
        </StateCell>
        <StateCell
          label="Hover and focus"
          canvas="surface"
          align="stretch"
          note="Surface fill on hover; the 2px brand ring on keyboard focus."
        >
          <StatefulAdvanced triggerClassName="bg-surface-2 outline-2 outline-offset-2 outline-ring/55" />
        </StateCell>

        <StateCell
          label="Loading"
          canvas="surface"
          align="stretch"
          note="The summary waits for the schedule's settings."
        >
          <Disclosure title="Advanced" loading>
            <span />
          </Disclosure>
        </StateCell>
        <StateCell
          label="Disabled with reason"
          canvas="surface"
          align="stretch"
          note="Monthly access review belongs to Maria Chen."
        >
          <Disclosure
            title="Advanced"
            disabled
            disabledReason="Only Maria Chen, who owns this schedule, can change how it runs."
          >
            <span />
          </Disclosure>
        </StateCell>

        <StateCell
          label="Error inside"
          canvas="surface"
          align="stretch"
          note="A problem inside a closed section replaces the summary and is never cut off."
        >
          <Disclosure title="Advanced" error="Data notebooks was deleted. Choose where it runs.">
            <span />
          </Disclosure>
        </StateCell>
        <StateCell
          label="Long summary"
          canvas="surface"
          align="stretch"
          note="One line in wide forms, two in narrow ones, then cut off. All of it shows once open."
        >
          <StatefulAdvanced
            values={{
              eachRun: "ongoing_chat",
              ifRunning: "skip",
              where: "env-data-notebooks",
              learning: "review_first",
            }}
          />
        </StateCell>

        <StateCell
          label="Technical details, open"
          canvas="surface"
          align="stretch"
          note="The other everyday use: IDs and endpoints stay out of PostHog's page until asked for."
        >
          <TechnicalDetails defaultOpen />
        </StateCell>
        <StateCell
          label="Mobile 390"
          canvas="surface"
          align="stretch"
          width="mobile"
          note="Under 480px the summary moves under the title."
        >
          <div className="flex min-w-0 flex-col">
            <StatefulAdvanced />
            <TechnicalDetails />
          </div>
        </StateCell>

        <StateCell
          label="Open"
          span="full"
          canvas="surface"
          align="stretch"
          note="The summary hides while the options show. The options line up with the title."
        >
          <div className="w-full max-w-[560px] min-w-0">
            <StatefulAdvanced defaultOpen />
          </div>
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="In a wide form"
        description="At 480px and wider the summary sits on the title's line, so a closed section costs one 44px row."
      >
        <KitCanvas canvas="surface" className="max-w-[640px]">
          <div className="flex min-w-0 flex-col">
            <StatefulAdvanced />
            <TechnicalDetails />
          </div>
        </KitCanvas>
      </KitBlock>

      <UsageNotes
        use={[
          "Secondary options of the same object, one level deep",
          "Advanced on a schedule; Technical details on a connection",
          "Advanced limits on a machine; prompt context in Insights",
        ]}
        avoid={[
          "Nesting one disclosure inside another",
          "Hiding the primary action, or a page's main content",
          "Opening another view - that is a row with a right chevron",
          "Settings people change often - leave them visible",
        ]}
      />
    </KitSection>
  );
}
