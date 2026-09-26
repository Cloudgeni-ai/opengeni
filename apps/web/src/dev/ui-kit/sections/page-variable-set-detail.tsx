import { useMemo, useState, type ReactNode } from "react";

import { DestructiveConfirmPanel } from "@/components/ui/destructive-confirm";

import { envPastePreview } from "../fixtures";
import {
  KitBlock,
  KitSection,
  PagePreview,
  StateCell,
  StatesGrid,
  UsageNotes,
  useKitPane,
} from "../kit";
import { useVerbs } from "../pages/variable-sets/answers";
import { VariableSetsApp } from "../pages/variable-sets/app";
import { announceUsage } from "../pages/variable-sets/detail";
import { AddVariableForm, ReplaceValueDialog } from "../pages/variable-sets/forms";
import { ChipGroup, PicksUsed, QuestionToggles } from "../pages/variable-sets/kit-controls";
import {
  blockedDeleteHint,
  confirmDependencies,
  emptySet,
  seedSets,
  usageEntries,
  type PreviewSet,
} from "../pages/variable-sets/model";

const SET_OPTIONS = [
  { value: "vs-aws-production", label: "AWS production" },
  { value: "vs-github-automation", label: "GitHub automation" },
  { value: "vs-staging-database", label: "Staging database" },
  { value: "vs-finance-exports", label: "Finance exports" },
  { value: "vs-sentry", label: "Sentry" },
] as const;

type SetOption = (typeof SET_OPTIONS)[number]["value"];

const SET_NOTES: Record<SetOption, string> = {
  "vs-aws-production":
    "Used by a schedule, so Delete variable set explains what uses it instead of deleting.",
  "vs-github-automation": "Used by a schedule and as the default for the Platform CI environment.",
  "vs-staging-database": "Nothing uses it, so it can be deleted.",
  "vs-finance-exports": "Shared by the organization with every workspace.",
  "vs-sentry": "Just created, with no variables yet.",
};

const STATE_OPTIONS = [
  { value: "ready", label: "Loaded" },
  { value: "loading", label: "Loading" },
] as const;

const noop = () => undefined;

const allSets: PreviewSet[] = [...seedSets("default"), emptySet()];

function fixtureSet(id: string): PreviewSet {
  const set = allSets.find((each) => each.id === id);
  if (!set) throw new Error(`Unknown variable set: ${id}`);
  return set;
}

const PASTED_ENV = [
  "# From the renovate runner",
  ...envPastePreview.rows.map((row) => `${row.name}=${row.value ?? "example"}`),
].join("\n");

/** Dependency links in a static panel can't leave the kit either. */
function StayInPreview({ set, children }: { set: PreviewSet; children: ReactNode }) {
  return (
    <div
      className="flex min-w-0 flex-1 items-start justify-center"
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest("a[href]");
        if (!anchor) return;
        event.preventDefault();
        const entry = usageEntries(set).find((each) => each.href === anchor.getAttribute("href"));
        if (entry) announceUsage(entry);
      }}
    >
      {children}
    </div>
  );
}

function DialogStates() {
  const verbs = useVerbs();
  const aws = fixtureSet("vs-aws-production");
  const github = fixtureSet("vs-github-automation");
  const staging = fixtureSet("vs-staging-database");
  const region = aws.variables.find((variable) => variable.name === "AWS_REGION")!;
  const secretKey = aws.variables.find((variable) => variable.name === "AWS_SECRET_ACCESS_KEY")!;

  return (
    <StatesGrid
      title="Dialogs on this page"
      columns={2}
      description="Drawn in place so you can compare them. In the page they open from Add variable, a row's ⋯ menu and the set's ⋯ menu."
    >
      <StateCell
        label="Add variable"
        align="stretch"
        note='Typed "aws session token"; the name is saved in uppercase with underscores.'
      >
        <div className="flex min-w-0 flex-1 items-start justify-center">
          <AddVariableForm
            presentation="panel"
            open
            set={aws}
            initialValues={{ name: "aws session token" }}
            onClose={noop}
            onAdd={noop}
          />
        </div>
      </StateCell>
      <StateCell
        label="Paste .env"
        align="stretch"
        note="One name is reserved and one is already in the set; both are explained before anything is saved."
      >
        <div className="flex min-w-0 flex-1 items-start justify-center">
          <AddVariableForm
            presentation="panel"
            open
            set={github}
            initialMode="paste"
            initialValues={{ env: PASTED_ENV }}
            onClose={noop}
            onAdd={noop}
          />
        </div>
      </StateCell>
      <StateCell label={verbs.replace} align="stretch">
        <div className="flex min-w-0 flex-1 items-start justify-center">
          <ReplaceValueDialog
            presentation="panel"
            set={aws}
            variable={secretKey}
            onClose={noop}
            onReplace={noop}
          />
        </div>
      </StateCell>
      <StateCell label={`${verbs.remove} a variable`} align="stretch">
        <div className="flex min-w-0 flex-1 items-start justify-center">
          <DestructiveConfirmPanel
            title={`${verbs.remove} ${region.name}?`}
            consequences={[
              `New turns in ${aws.usedBy[0]?.name ?? "its schedule"} won't get ${region.name}.`,
              "Turns already running keep it.",
              "This can't be undone.",
            ]}
            confirmLabel={`${verbs.remove} variable`}
            onConfirm={() => undefined}
          />
        </div>
      </StateCell>
      <StateCell
        label={`${verbs.remove} a set that's in use`}
        align="stretch"
        note="No destructive button. Each row links to where the set is used."
      >
        <StayInPreview set={aws}>
          <DestructiveConfirmPanel
            variant="blocked"
            title={`${aws.name} is in use`}
            description={blockedDeleteHint(aws, verbs.remove)}
            dependencies={confirmDependencies(aws)}
          />
        </StayInPreview>
      </StateCell>
      <StateCell label={`${verbs.remove} a set nothing uses`} align="stretch">
        <div className="flex min-w-0 flex-1 items-start justify-center">
          <DestructiveConfirmPanel
            title={`${verbs.remove} ${staging.name}?`}
            consequences={[
              `Its ${staging.variables.length} variables go with it.`,
              "Nothing uses it right now, so no chat or schedule changes.",
              "This can't be undone.",
            ]}
            confirmLabel={`${verbs.remove} variable set`}
            onConfirm={() => undefined}
          />
        </div>
      </StateCell>
    </StatesGrid>
  );
}

export default function PageVariableSetDetailSection() {
  const pane = useKitPane();
  const [setId, setSetId] = useState<SetOption>("vs-aws-production");
  const [state, setState] = useState<(typeof STATE_OPTIONS)[number]["value"]>("ready");
  const appKey = useMemo(() => `${setId}:${state}`, [setId, state]);

  return (
    <KitSection sectionKey="page-variable-set-detail">
      <KitBlock
        title="The page"
        description="What opens when you click a variable set. The back link returns to the list; every menu, dialog and form works on the fixtures."
      >
        <div className="flex min-w-0 flex-col gap-4">
          {pane.mobileFrame ? null : <QuestionToggles collapsible={pane.count > 1} />}
          <div className="flex min-w-0 flex-col gap-2">
            <ChipGroup
              label="Set"
              value={setId}
              onChange={setSetId}
              options={SET_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            />
            <ChipGroup
              label="State"
              value={state}
              onChange={setState}
              options={STATE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
            <p className="text-xs leading-4.5 text-fg-muted">{SET_NOTES[setId]}</p>
          </div>
          <PagePreview label="Variable set page preview" height={pane.mobileFrame ? 720 : 800}>
            <VariableSetsApp
              key={appKey}
              dataState={state === "loading" ? "loading" : "default"}
              initialSetId={setId}
              withEmptySet
            />
          </PagePreview>
        </div>
      </KitBlock>

      {pane.mobileFrame ? null : (
        <KitBlock
          title="Built from your picks"
          description="Each chip opens that component. Change a pick there and this page follows."
        >
          <PicksUsed />
        </KitBlock>
      )}

      <DialogStates />

      <UsageNotes
        title="What this page does"
        use={[
          "Variables as one table: Name, Value and Updated, with Replace value and Delete in the row's ⋯ menu.",
          'Secrets read "Secret" and are never shown. Plain config shows inline once variables have a Secret flag.',
          "Used by lists every schedule, chat and environment default, each linked.",
          "Delete explains what uses the set instead of failing after the click.",
        ]}
        avoid={[
          "Reveal, Copy, version numbers or a •••••• pill on every row.",
          "An add form that is always open under the table.",
          "Rotate and Revoke for values OpenGeni only stores.",
        ]}
      />
    </KitSection>
  );
}
