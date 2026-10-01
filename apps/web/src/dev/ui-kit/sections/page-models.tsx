import { useId, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DetailPage } from "@/components/ui/detail-sheet";
import { Disclosure } from "@/components/ui/disclosure";
import { HelpTip } from "@/components/ui/inline-help";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";

import { organization } from "../fixtures";
import { KitBlock, KitCanvas, KitSection, useKitPane } from "../kit";
import { DetailView, ModelsPreview } from "../pages/models/models-page";
import {
  DEFAULT_QUESTIONS,
  ModelsProvider,
  useModels,
  type Questions,
  type Scenario,
} from "../pages/models/state";

/* ----------------------------------------------------------------------------
   Pages > Models: workspace Settings > Models and Organization settings >
   Models, assembled from the real primitives with Bendik's picks. The open
   product questions (Q11-Q15) and a few scenarios are switchable above the
   page, so each answer can be judged in place.
   -------------------------------------------------------------------------- */

interface ControlProps<Value extends string> {
  label: string;
  /** What each answer means, in a help tip. */
  help: ReactNode;
  value: Value;
  options: readonly SegmentedControlOption<Value>[];
  onChange: (value: Value) => void;
  /** The recommended answer; the label says when the other one is showing. */
  recommended?: Value;
}

function Control<Value extends string>({
  label,
  help,
  value,
  options,
  onChange,
  recommended,
}: ControlProps<Value>) {
  const labelId = useId();
  const other = recommended !== undefined && value !== recommended;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-1.5">
        <span id={labelId} className="text-xs leading-4.5 font-medium text-fg-muted">
          {label}
        </span>
        <HelpTip label={`About ${label}`}>{help}</HelpTip>
        {other ? (
          <span className="text-xs leading-4.5 text-status-waiting">· other answer</span>
        ) : null}
      </div>
      <SegmentedControl<Value>
        size="sm"
        aria-labelledby={labelId}
        value={value}
        onValueChange={onChange}
        options={options.map((option) =>
          option.value === recommended
            ? {
                ...option,
                label: (
                  <>
                    {option.label}
                    <span className="sr-only"> (recommended)</span>
                  </>
                ),
              }
            : option,
        )}
      />
    </div>
  );
}

function ControlGroup({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 px-4 py-4">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm leading-5 font-semibold text-fg">
            {title}
          </h3>
          <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">{description}</p>
        </div>
        {aside ? <div className="-mt-1 shrink-0">{aside}</div> : null}
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap gap-x-8 gap-y-4">{children}</div>
    </section>
  );
}

function PreviewControls() {
  const { questions, setQuestions, scenario, setScenario, reset } = useModels();
  const pane = useKitPane();
  const changed = (Object.keys(DEFAULT_QUESTIONS) as Array<keyof Questions>).filter(
    (key) => questions[key] !== DEFAULT_QUESTIONS[key],
  ).length;
  const question =
    <K extends keyof Questions>(key: K) =>
    (value: Questions[K]) =>
      setQuestions({ [key]: value } as Partial<Questions>);
  const org = organization.name;
  const controls = (
    <div className="flex min-w-0 flex-col divide-y divide-border rounded-[14px] border border-border bg-surface">
      <ControlGroup
        title="Open questions"
        description="Q11-Q15 aren't answered yet. The page starts on our recommendations; switch one to see the other answer in place."
      >
        <Control
          label="Q11 Organization links"
          help={`Recommended: remove the links and list the organization's accounts with an Organization badge. Other answer: keep "Manage organization connections".`}
          value={questions.q11}
          recommended="remove"
          onChange={question("q11")}
          options={[
            { value: "remove", label: "Remove" },
            { value: "keep", label: "Keep" },
          ]}
        />
        <Control
          label="Q12 Account details"
          help="Recommended: one row per account that opens the account's own page. Other answer: expand each account in place."
          value={questions.q12}
          recommended="page"
          onChange={question("q12")}
          options={[
            { value: "page", label: "Own page" },
            { value: "inline", label: "In place" },
          ]}
        />
        <Control
          label="Q13 Codex source"
          help={`Decided 28 Sep: no control. New work uses this workspace's accounts when any are connected, otherwise ${org}'s; a line above Accounts says which, and the other pool's rows show "Not in use". Other answer: today's four-option select.`}
          value={questions.q13}
          recommended="segmented"
          onChange={question("q13")}
          options={[
            { value: "segmented", label: "Automatic" },
            { value: "select", label: "Select" },
          ]}
        />
        <Control
          label="Q14 Account selection"
          help={`Recommended: "Spread work | Primary only", a Primary chip and a "Use for new work" switch. Other answer: today's Auto-rotate checkbox and active account.`}
          value={questions.q14}
          recommended="modes"
          onChange={question("q14")}
          options={[
            { value: "modes", label: "Spread or primary" },
            { value: "legacy", label: "Auto-rotate" },
          ]}
        />
        <Control
          label="Q15 Per-account model lists"
          help={`Recommended: "Models it can serve" only on the organization's accounts; workspaces use Allowed models. Other answer: on workspace accounts too.`}
          value={questions.q15}
          recommended="org_only"
          onChange={question("q15")}
          options={[
            { value: "org_only", label: "Organization" },
            { value: "everywhere", label: "Everywhere" },
          ]}
        />
      </ControlGroup>
      <ControlGroup
        title="Scenario"
        description="Who is looking and what state the page is in. Everything saves with fixtures."
        aside={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setScenario({ load: "ready" });
            }}
            className="text-fg-muted pointer-coarse:h-11"
          >
            <RotateCcwIcon aria-hidden="true" />
            Reset
          </Button>
        }
      >
        <Control
          label="Settings area"
          help="The Organization link in the settings sub-nav switches this too."
          value={scenario.scope}
          onChange={(scope: Scenario["scope"]) => setScenario({ scope })}
          options={[
            { value: "workspace", label: "Workspace" },
            {
              value: "organization",
              label: "Organization",
              disabled: scenario.viewer !== "org_admin",
              disabledReason: `Only owners and admins of ${org} can open organization settings.`,
            },
          ]}
        />
        <Control
          label="You are"
          help={`A workspace admin sees the organization's account read-only, without a link to organization settings, and can't redeem someone else's resets.`}
          value={scenario.viewer}
          onChange={(viewer: Scenario["viewer"]) =>
            setScenario(viewer === "org_admin" ? { viewer } : { viewer, scope: "workspace" })
          }
          options={[
            { value: "org_admin", label: "Org admin" },
            { value: "workspace_admin", label: "Workspace admin" },
          ]}
        />
        <Control
          label={`${org} shares Codex`}
          help={`Whether ${org} has assigned a Codex account to Design preview. When it hasn't, "Use: Organization | This workspace" and the Organization row are hidden.`}
          value={scenario.orgAssigned ? "yes" : "no"}
          onChange={(value) => setScenario({ orgAssigned: value === "yes" })}
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
        />
        <Control
          label="Page"
          help="Loading shows the skeleton; Couldn't load shows the error with Try again."
          value={scenario.load}
          onChange={(load: Scenario["load"]) => setScenario({ load })}
          options={[
            { value: "ready", label: "Ready" },
            { value: "loading", label: "Loading" },
            { value: "error", label: "Error" },
          ]}
        />
      </ControlGroup>
    </div>
  );
  if (!pane.mobileFrame) return controls;
  // On a phone the page comes first; the switches fold away.
  return (
    <Disclosure
      title="Open questions and scenario"
      summary={`${changed === 0 ? "Recommended answers" : `${changed} other ${changed === 1 ? "answer" : "answers"}`} · ${scenario.scope === "organization" ? "Organization" : "Workspace"} settings`}
    >
      {controls}
    </Disclosure>
  );
}

function DetailPagePreviews() {
  const { setScenario, openDetail } = useModels();
  const previews: Array<{
    label: string;
    target: Parameters<typeof DetailView>[0]["target"];
    note: string;
  }> = [
    {
      label: "ops@acme.dev",
      target: { kind: "codex", scope: "workspace", id: "acct-ops" },
      note: "A workspace account. Everything here saves.",
    },
    {
      label: "platform@acme.dev",
      target: { kind: "codex", scope: "organization", id: "acct-platform" },
      note: `Shared by ${organization.name}, seen from Design preview: read-only.`,
    },
  ];
  return (
    <KitBlock
      title="Account pages"
      description="The page a row opens, drawn in place so both kinds can be compared. It shares state with the page above."
    >
      <div className="flex min-w-0 flex-col gap-6">
        {previews.map((preview) => (
          <figure key={preview.label} className="m-0 flex min-w-0 flex-col gap-2">
            <figcaption className="text-xs font-medium text-fg-muted">{preview.note}</figcaption>
            <KitCanvas>
              <DetailPage
                back={{ label: "Models" }}
                className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
              >
                <DetailView
                  target={preview.target}
                  view={{
                    pageScope: "workspace",
                    onManageInOrganization: (id) => {
                      setScenario({ scope: "organization" });
                      openDetail({ kind: "codex", scope: "organization", id });
                    },
                  }}
                />
              </DetailPage>
            </KitCanvas>
          </figure>
        ))}
      </div>
    </KitBlock>
  );
}

export default function PageModelsSection() {
  return (
    <KitSection sectionKey="page-models">
      <ModelsProvider>
        <KitBlock
          title="Page"
          description="Settings > Models inside the app, with your picks: Defaults, one flat Accounts list, then the Codex settings as rows. Open a row, Connect account, Allowed models, or the Organization link in the sub-nav. Every account and form is its own page with a back link."
        >
          <PreviewControls />
          <div className="mt-4 min-w-0">
            <ModelsPreview />
          </div>
        </KitBlock>
        <DetailPagePreviews />
      </ModelsProvider>
    </KitSection>
  );
}
