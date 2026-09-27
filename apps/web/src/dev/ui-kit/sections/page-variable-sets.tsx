import { useState } from "react";

import {
  KitBlock,
  KitSection,
  PagePreview,
  StateCell,
  StatesGrid,
  UsageNotes,
  useKitPane,
} from "../kit";
import { VariableSetsApp } from "../pages/variable-sets/app";
import { NewSetForm, SET_TEMPLATES } from "../pages/variable-sets/forms";
import { ChipGroup, PicksUsed, QuestionToggles } from "../pages/variable-sets/kit-controls";
import { seedSets, type DataState } from "../pages/variable-sets/model";

const DATA_OPTIONS: { value: DataState; label: string }[] = [
  { value: "default", label: "5 sets" },
  { value: "many", label: "13 sets (search)" },
  { value: "empty", label: "None yet" },
  { value: "loading", label: "Loading" },
  { value: "error", label: "Couldn't load" },
];

const noop = () => undefined;
const fixtureSets = seedSets("default");

export default function PageVariableSetsSection() {
  const pane = useKitPane();
  const [dataState, setDataState] = useState<DataState>("default");

  return (
    <KitSection sectionKey="page-variable-sets">
      <KitBlock
        title="The page"
        description="Workspace settings, Variable sets, built from the decided picks. A row opens the set's own page with a back link; New variable set is its own page too. Creating, adding, replacing and deleting all work on the fixtures."
      >
        <div className="flex min-w-0 flex-col gap-4">
          {pane.mobileFrame ? null : <QuestionToggles collapsible={pane.count > 1} />}
          <ChipGroup
            label="Data"
            value={dataState}
            onChange={setDataState}
            options={DATA_OPTIONS}
          />
          <PagePreview label="Variable sets page preview" height={pane.mobileFrame ? 720 : 800}>
            <VariableSetsApp key={dataState} dataState={dataState} />
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

      <StatesGrid
        title="New variable set"
        columns={2}
        description="The create form, framed here so the states sit side by side. In the page it is its own page (/variable-sets/new) with a back link and a sticky footer."
      >
        <StateCell label="Empty" align="stretch" canvas="bg">
          <div className="flex min-w-0 flex-1 items-start justify-center">
            <NewSetForm
              presentation="panel"
              open
              sets={fixtureSets}
              onClose={noop}
              onCreate={noop}
            />
          </div>
        </StateCell>
        <StateCell
          label="From a template, with a .env to fill in"
          align="stretch"
          canvas="bg"
          note="Submitting asks for the two empty values instead of saving blanks."
        >
          <div className="flex min-w-0 flex-1 items-start justify-center">
            <NewSetForm
              presentation="panel"
              open
              template={SET_TEMPLATES[0]}
              sets={fixtureSets}
              onClose={noop}
              onCreate={noop}
            />
          </div>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        title="What this page does"
        use={[
          "One borderless list. The whole row opens the set's own page, where its variables and what uses it live.",
          "New variable set opens its own page. After Create, you land on the new set's page.",
          "Who can use a set shows only when it isn't this workspace, and the list groups by it only when sets are mixed.",
          "Search appears past 10 sets and also matches variable names.",
          "The header's New variable set hides while the empty state offers it.",
        ]}
        avoid={[
          "A right-side sheet, expanding cards in place, a card inside a card, or a dropdown-looking expander.",
          "Manage variables, Edit details and a trash icon on every row.",
          'A Workspace chip on every row, timestamps with seconds, or "attachment" wording.',
        ]}
      />
    </KitSection>
  );
}
