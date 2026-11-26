/**
 * Get started: the front door into Enable (docs/agents.md#guided-setups).
 * A showcase: an example of what the selected setup produces, labelled
 * "Example", beside the setups; one button opens the selected setup on the
 * Enable page (components/enable), with what it needs underneath. Hovering or
 * selecting a setup swaps the example. `?setup=` opens one setup on Enable.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRightIcon, ChartLineIcon, GitPullRequestIcon, ListChecksIcon } from "lucide-react";
import type { AgentTemplate } from "@opengeni/sdk";

import { useAppContext } from "@opengeni/react/app/app-context";
import { cn } from "@opengeni/react/app/lib/utils";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { Button } from "@opengeni/react/ui/button";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { StatusDot } from "@opengeni/react/ui/status-dot";

import { EnablePage } from "../enable/enable-page";
import type { EnableStep } from "../enable/enable-subject";
import {
  GUIDED_SETUPS,
  guidedSetupByKey,
  needsLine,
  setupNeeds,
  type GuidedSetup,
} from "./guided-setups";

const SETUP_ICONS: Record<GuidedSetup["icon"], ReactNode> = {
  "git-pull-request": <GitPullRequestIcon />,
  "list-checks": <ListChecksIcon />,
  "chart-line": <ChartLineIcon />,
};

export function getStartedHref(workspaceId: string, setupKey?: string, step?: EnableStep): string {
  const params = new URLSearchParams();
  if (setupKey) params.set("setup", setupKey);
  if (step) params.set("step", step);
  const search = params.toString();
  return `/workspaces/${encodeURIComponent(workspaceId)}/get-started${search ? `?${search}` : ""}`;
}

export function GetStartedPage({
  workspaceId,
  setupKey,
  step,
}: {
  workspaceId: string;
  setupKey?: string | undefined;
  step?: EnableStep | undefined;
}) {
  const navigate = useNavigate();
  const setup = guidedSetupByKey(setupKey);
  if (setup) {
    return (
      <EnablePage
        key={setup.key}
        workspaceId={workspaceId}
        subject={{
          kind: "agent",
          templateKey: setup.agentTemplateKey,
          triggerName: setup.triggerName,
          requireProviders: setup.requireProviders,
        }}
        step={step}
        title={setup.title}
        description={setup.description}
        icon={SETUP_ICONS[setup.icon]}
        back={{
          label: "Get started",
          onClick: () => void navigate({ href: getStartedHref(workspaceId) }),
        }}
        returnPath={getStartedHref(workspaceId, setup.key, "connect")}
      />
    );
  }
  return (
    <Showcase
      workspaceId={workspaceId}
      onOpen={(key) => void navigate({ href: getStartedHref(workspaceId, key) })}
    />
  );
}

/** The agent templates, for what each setup needs; null while they load or when they can't. */
function useTemplates(workspaceId: string): AgentTemplate[] | null {
  const { client } = useAppContext();
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  useEffect(() => {
    let live = true;
    client.listAgentTemplates(workspaceId).then(
      (list) => live && setTemplates(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return templates;
}

export function Showcase({
  workspaceId,
  onOpen,
  initialKey,
}: {
  workspaceId: string;
  onOpen: (key: string) => void;
  initialKey?: string | undefined;
}) {
  const templates = useTemplates(workspaceId);
  const [selectedKey, setSelectedKey] = useState(initialKey ?? GUIDED_SETUPS[0]!.key);
  const selected = guidedSetupByKey(selectedKey) ?? GUIDED_SETUPS[0]!;
  const template = templates?.find((entry) => entry.key === selected.agentTemplateKey) ?? null;
  const needs = templates ? needsLine(setupNeeds(selected, template)) : null;
  return (
    <div className="mx-auto w-full max-w-[1040px] px-8 pt-10 pb-12 max-sm:px-4 max-sm:pt-6">
      <section
        data-get-started-showcase=""
        aria-labelledby="get-started-title"
        className="grid overflow-hidden rounded-xl border border-border bg-surface lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
      >
        <div className="order-2 border-border bg-surface-2 p-6 max-lg:border-t lg:order-1 lg:border-r lg:p-8">
          <SetupExampleCard setup={selected} />
        </div>
        <div className="order-1 flex flex-col p-6 lg:order-2 lg:p-8">
          <h1 id="get-started-title" className="text-xl leading-7 font-semibold text-fg">
            Put agents on your engineering work
          </h1>
          <p className="mt-1 text-sm text-fg-muted">Each one is ready in three steps.</p>
          <div role="radiogroup" aria-label="Setups" className="mt-6 flex flex-col gap-1">
            {GUIDED_SETUPS.map((entry) => {
              const active = entry.key === selected.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-setup={entry.key}
                  onMouseEnter={() => setSelectedKey(entry.key)}
                  onFocus={() => setSelectedKey(entry.key)}
                  onClick={() => setSelectedKey(entry.key)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40",
                    active ? "border-border bg-surface-2" : "border-transparent hover:bg-hover",
                  )}
                >
                  <LogoTile size="md" name={entry.title} icon={SETUP_ICONS[entry.icon]} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{entry.title}</span>
                    <span className="block text-xs leading-4.5 text-fg-muted">
                      {entry.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            className="mt-6 w-full"
            data-get-started-open=""
            onClick={() => onOpen(selected.key)}
          >
            {selected.action}
            <ArrowRightIcon aria-hidden="true" />
          </Button>
          <p className="mt-2 min-h-4 text-center text-xs text-fg-muted" data-get-started-needs="">
            {needs ?? ""}
          </p>
        </div>
      </section>
    </div>
  );
}

/** What the setup's agent produces, drawn from its definition and labelled "Example". */
export function SetupExampleCard({ setup }: { setup: GuidedSetup }) {
  const example = setup.example;
  return (
    <figure data-setup-example={setup.key} aria-label={`Example: ${setup.title}`}>
      <MetaChip variant="outline">Example</MetaChip>
      <div className="mt-6 flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <LogoTile size="sm" name={example.subject} icon={SETUP_ICONS[setup.icon]} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{example.subject}</p>
            <p className="text-xs text-fg-muted">{example.subjectMeta}</p>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{setup.agentName}</span>
            <StatusBadge tone={example.verdictTone} variant="outline">
              {example.verdict}
            </StatusBadge>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {example.lines.map((line) => (
              <li key={line.label} className="flex items-baseline gap-2 text-sm">
                <StatusDot tone={line.tone} size="sm" className="translate-y-[-1px]" />
                <span className="w-16 shrink-0 text-xs text-fg-muted">{line.label}</span>
                <span className="text-fg">{line.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </figure>
  );
}
