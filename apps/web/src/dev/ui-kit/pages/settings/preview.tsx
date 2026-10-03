import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";

import type { AccessMember } from "@/components/ui/access-list";
import { Button } from "@/components/ui/button";

import { currentWorkspace, designPreviewAccessRequests, type WorkspaceRole } from "../../fixtures";
import { PagePreview, KitBlock } from "../../kit";
import { useExplicitPick, usePick } from "../../picks";
import { alternativeLetter, getSection, type SectionKey } from "../../sections/registry";
import { kitHref, useKitNavigate, useKitView } from "../../view";
import { AccessPage } from "./access-page";
import { ApiKeysPage } from "./api-keys-page";
import { PreviewControls, YES_NO, asToggle, type PreviewToggle, type YesNo } from "./controls";
import { INITIAL_API_KEYS, VIEWER_PERSON, initialAccess, type Viewer } from "./data";
import { DangerZonePage, GeneralPage } from "./general-page";
import { useSettingsPicks } from "./picks";
import { SettingsFrame, type FramePage, type SettingsPageId } from "./settings-frame";
import { useFrameBase } from "./shared";
import {
  SettingsPreviewContext,
  useSettingsPreview,
  type PageData,
  type PauseState,
  type QuestionId,
  type SettingsPreviewState,
} from "./state";

/* ----------------------------------------------------------------------------
   Open questions (design brief section 12, Q4-Q9).
   -------------------------------------------------------------------------- */

const QUESTIONS: Record<
  QuestionId,
  { tag: string; label: string; question: string; pages?: FramePage[] }
> = {
  q4: {
    tag: "Q4",
    label: "Keep the main rail",
    question:
      "Stop swapping the rail: add a labelled Settings item and show the settings sub-nav inside the content? Recommended: Yes. No shows the settings rail that replaces the main rail.",
  },
  q5: {
    tag: "Q5",
    label: "Settings is configuration only",
    question:
      "Remove Memory and the Settings > Capabilities stub, and move Insights to the main rail, under More? Recommended: Yes.",
  },
  q6: {
    tag: "Q6",
    label: "Delete lives in General",
    question:
      "Fold Danger zone into the bottom of General as a quiet Delete workspace row with a preflight? Recommended: Yes. No keeps a Danger zone page.",
    pages: ["general", "danger-zone"],
  },
  q7: {
    tag: "Q7",
    label: "Agent activity row",
    question:
      "Replace the Pause split button with an Agent activity row (status plus a Pause button that opens a small dialog), and show a banner across the workspace while paused? Recommended: Yes.",
    pages: ["general"],
  },
  q8: {
    tag: "Q8",
    label: "One control per row",
    question:
      "One control per session-default row: provider and funding become sub-rows, and Allow other providers moves to Models > Codex? Recommended: Yes.",
    pages: ["general"],
  },
  q9: {
    tag: "Q9",
    label: "Presets, expiry, token once",
    question:
      "Access presets instead of 40 scopes, an expiry that defaults to 90 days, the token shown once inside the dialog, and revoked or expired keys collapsed at the bottom? Recommended: Yes.",
    pages: ["api-keys"],
  },
};

const QUESTION_ORDER: QuestionId[] = ["q4", "q5", "q6", "q7", "q8", "q9"];

const DATA_OPTIONS: {
  [K in keyof PageData]: ReadonlyArray<{ value: PageData[K]; label: string }>;
} = {
  general: [
    { value: "filled", label: "Loaded" },
    { value: "loading", label: "Loading" },
  ],
  access: [
    { value: "filled", label: "Loaded" },
    { value: "only-you", label: "Only you" },
    { value: "loading", label: "Loading" },
    { value: "error", label: "Error" },
  ],
  "api-keys": [
    { value: "filled", label: "Loaded" },
    { value: "empty", label: "No keys" },
    { value: "loading", label: "Loading" },
    { value: "error", label: "Error" },
  ],
};

/* ----------------------------------------------------------------------------
   The routed page.
   -------------------------------------------------------------------------- */

function OtherPage() {
  const base = useFrameBase();
  return <SettingsFrame {...base} />;
}

function CurrentPage() {
  const { page } = useSettingsPreview();
  if (page === "general") return <GeneralPage />;
  if (page === "access") return <AccessPage />;
  if (page === "api-keys") return <ApiKeysPage />;
  if (page === "danger-zone") return <DangerZonePage />;
  return <OtherPage />;
}

/* ----------------------------------------------------------------------------
   State and controls.
   -------------------------------------------------------------------------- */

function PreviewBody({
  initialPage,
  label,
  onReset,
}: {
  initialPage: SettingsPageId;
  label: string;
  onReset: () => void;
}) {
  const picks = useSettingsPicks();
  const railPicked = picks.nav === "rail";
  const [page, setPage] = useState<FramePage>(initialPage);
  const [viewer, setViewer] = useState<Viewer>("admin");
  const [questions, setQuestions] = useState<Record<QuestionId, YesNo>>({
    q4: railPicked ? "no" : "yes",
    q5: "yes",
    q6: "yes",
    q7: "yes",
    q8: "yes",
    q9: "yes",
  });
  const [data, setDataState] = useState<PageData>({
    general: "filled",
    access: "filled",
    "api-keys": "filled",
  });
  const [workspaceName, setWorkspaceName] = useState(currentWorkspace.name);
  const [pause, setPause] = useState<PauseState>({ paused: false, until: null });
  const [gatewayConnected, setGatewayConnected] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [members, setMembers] = useState<AccessMember<WorkspaceRole>[]>(() =>
    initialAccess("admin"),
  );
  const [requests, setRequests] = useState(designPreviewAccessRequests);
  const [keys, setKeys] = useState(INITIAL_API_KEYS);

  // Question 4 follows the Navigation pick until it is flipped here.
  useEffect(() => {
    setQuestions((current) => ({ ...current, q4: railPicked ? "no" : "yes" }));
  }, [railPicked]);

  // Question 6 answered Yes has no Danger zone page to stay on.
  useEffect(() => {
    if (questions.q6 === "yes" && page === "danger-zone") setPage("general");
  }, [page, questions.q6]);

  const viewerPerson = VIEWER_PERSON[viewer];
  const state = useMemo<SettingsPreviewState>(
    () => ({
      page,
      navigate: setPage,
      viewer,
      viewerPerson,
      canManage: viewer === "admin",
      questions,
      data,
      setData: (key, value) => setDataState((current) => ({ ...current, [key]: value })),
      nav: questions.q4 === "no" ? "rail" : picks.nav === "tabs" ? "tabs" : "column",
      workspaceName,
      setWorkspaceName,
      pause,
      setPause,
      gatewayConnected,
      setGatewayConnected,
      deleted,
      setDeleted,
      members: members.map((member) => ({ ...member, isYou: member.id === viewerPerson.id })),
      setMembers,
      requests,
      setRequests,
      keys,
      setKeys,
    }),
    [
      data,
      deleted,
      gatewayConnected,
      keys,
      members,
      page,
      pause,
      picks.nav,
      questions,
      requests,
      viewer,
      viewerPerson,
      workspaceName,
    ],
  );

  const questionToggles: PreviewToggle<string>[] = QUESTION_ORDER.filter((id) => {
    const pages = QUESTIONS[id].pages;
    return !pages || pages.includes(page);
  }).map((id) =>
    asToggle({
      tag: QUESTIONS[id].tag,
      label: QUESTIONS[id].label,
      help: QUESTIONS[id].question,
      value: questions[id],
      options: YES_NO,
      onChange: (value) => setQuestions((current) => ({ ...current, [id]: value })),
    }),
  );

  const dataKey: keyof PageData | null =
    page === "general" || page === "access" || page === "api-keys" ? page : null;
  const stateToggles: PreviewToggle<string>[] = [
    asToggle<Viewer>({
      label: "Viewing as",
      help: "Bendik Hansen is a workspace admin. Maria Chen is a member of Design preview and sees settings read-only.",
      value: viewer,
      options: [
        { value: "admin", label: "Workspace admin" },
        { value: "member", label: "Member" },
      ],
      onChange: setViewer,
    }),
    ...(dataKey
      ? [
          asToggle<string>({
            label: "Data",
            value: data[dataKey],
            options: DATA_OPTIONS[dataKey],
            onChange: (value) =>
              setDataState((current) => ({ ...current, [dataKey]: value }) as PageData),
          }),
        ]
      : []),
  ];

  return (
    <SettingsPreviewContext.Provider value={state}>
      <div className="flex min-w-0 flex-col gap-3">
        <PreviewControls
          questions={questionToggles}
          states={stateToggles}
          aside={
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              <RotateCcwIcon aria-hidden="true" />
              Start over
            </Button>
          }
        />
        <PagePreview label={`${label}, workspace settings`}>
          <CurrentPage />
        </PagePreview>
      </div>
    </SettingsPreviewContext.Provider>
  );
}

/**
 * One workspace settings page inside the app frame, with the open questions
 * and preview states above it. General, Access and API keys share one state,
 * so moving between them in the sub-nav keeps what you changed.
 */
export function SettingsPreview({
  initialPage,
  label,
}: {
  initialPage: SettingsPageId;
  label: string;
}) {
  const [run, setRun] = useState(0);
  return (
    <PreviewBody
      key={run}
      initialPage={initialPage}
      label={label}
      onReset={() => setRun((value) => value + 1)}
    />
  );
}

/* ----------------------------------------------------------------------------
   Picks this page follows, with links to their sections.
   -------------------------------------------------------------------------- */

function PickLink({ sectionKey }: { sectionKey: SectionKey }) {
  const view = useKitView();
  const navigate = useKitNavigate(view);
  const pick = usePick(sectionKey);
  const explicit = useExplicitPick(sectionKey);
  const section = getSection(sectionKey);
  const name = section.alternatives?.find((alternative) => alternative.id === pick)?.name;
  return (
    <li className="min-w-0">
      <a
        href={kitHref({ section: sectionKey, theme: view.theme, width: view.width })}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigate({ section: sectionKey });
        }}
        className="group flex min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-sm transition-colors duration-[120ms] hover:bg-surface-2 pointer-coarse:min-h-11"
      >
        <span
          aria-hidden="true"
          className={
            explicit
              ? "grid size-5 shrink-0 place-items-center rounded-md bg-brand-strong text-2xs font-semibold text-brand-fg"
              : "grid size-5 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-2xs font-semibold text-fg-muted"
          }
        >
          {alternativeLetter(pick)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-5 font-medium text-fg">{section.title}</span>
          <span className="truncate text-xs leading-4.5 text-fg-subtle">
            {name}
            {explicit ? "" : " · decided"}
          </span>
        </span>
      </a>
    </li>
  );
}

/** The component picks a page is built from, each linking to its section. */
export function PicksInUse({ keys, children }: { keys: SectionKey[]; children?: ReactNode }) {
  return (
    <KitBlock
      title="Built from your picks"
      description="Change a pick in its section and this page follows. A filled letter is your pick; an outlined one is the decided default."
    >
      <ul className="m-0 grid min-w-0 list-none gap-x-4 gap-y-0.5 p-0 @xl/kit-section:grid-cols-2 @4xl/kit-section:grid-cols-3">
        {keys.map((key) => (
          <PickLink key={key} sectionKey={key} />
        ))}
      </ul>
      {children}
    </KitBlock>
  );
}
