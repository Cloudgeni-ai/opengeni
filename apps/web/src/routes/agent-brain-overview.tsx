import type { WorkspaceStateResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  Building2Icon,
  FileSearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

function SummaryGroup(props: { title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${props.title.toLowerCase().replaceAll(" ", "-")}-heading`}>
      <div className="mb-4 px-0.5">
        <h2
          id={`${props.title.toLowerCase().replaceAll(" ", "-")}-heading`}
          className="text-xs font-semibold uppercase tracking-wider text-fg-subtle"
        >
          {props.title}
        </h2>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {props.children}
      </div>
    </section>
  );
}

function SummaryRow(props: {
  icon: ReactNode;
  title: string;
  description: string;
  status: string;
  tone?: "default" | "warning";
  action?: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <span className="self-start rounded-md bg-brand/10 p-2 text-brand">{props.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-medium text-fg">{props.title}</h3>
          <span
            className={
              props.tone === "warning"
                ? "text-xs font-medium text-status-waiting"
                : "text-xs text-fg-muted"
            }
          >
            {props.status}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-fg-muted">{props.description}</p>
      </div>
      {props.action ? <div className="shrink-0 sm:ml-3">{props.action}</div> : null}
    </article>
  );
}

function FocusAction({
  children,
  view,
  workspaceId,
}: {
  children: ReactNode;
  view: "company" | "instructions" | "preferences";
  workspaceId: string;
}) {
  return (
    <Link
      to="/workspaces/$workspaceId/state"
      params={{ workspaceId }}
      search={{ view }}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
    >
      {children}
      <ArrowRightIcon className="size-3" />
    </Link>
  );
}

function RouteAction({
  children,
  to,
  workspaceId,
}: {
  children: ReactNode;
  to: "/workspaces/$workspaceId/documents" | "/workspaces/$workspaceId/memory";
  workspaceId: string;
}) {
  return (
    <Link
      to={to}
      params={{ workspaceId }}
      search={{ from: "brain" }}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
    >
      {children}
      <ArrowRightIcon className="size-3" />
    </Link>
  );
}

function workspaceInstructionStatus(state: WorkspaceStateResponse): string {
  if (state.policy.activeHeads.length > 0) {
    const suffix = state.policy.activeHeadsTruncated ? "+" : "";
    return `${state.policy.activeHeads.length}${suffix} active`;
  }
  if (state.policy.legacyRuntime.workspaceOverrideConfigured) {
    return "Custom instructions configured";
  }
  return "Not set";
}

function documentStatus(state: WorkspaceStateResponse): {
  status: string;
  tone: "default" | "warning";
} {
  if (state.knowledge.availability === "unavailable") {
    return { status: "Permission required", tone: "warning" };
  }

  const counts = state.knowledge.documentStatusCounts;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const needsAttention = counts.failed + counts.queued + counts.indexing;
  const parts = [`${total} document${total === 1 ? "" : "s"}`, `${counts.ready} ready`];
  if (needsAttention > 0) parts.push(`${needsAttention} need attention`);
  if (state.knowledge.coverage === "partial") parts.push("partial view");
  return {
    status: parts.join(" · "),
    tone: needsAttention > 0 || state.knowledge.coverage === "partial" ? "warning" : "default",
  };
}

function memoryStatus(state: WorkspaceStateResponse): {
  status: string;
  tone: "default" | "warning";
} {
  if (state.knowledge.availability === "unavailable") {
    return { status: "Permission required", tone: "warning" };
  }
  const sample = state.knowledge.memorySample;
  return {
    status: sample.limitReached
      ? `${sample.recordCount}+ recent records`
      : `${sample.recordCount} recent record${sample.recordCount === 1 ? "" : "s"}`,
    tone: sample.limitReached ? "warning" : "default",
  };
}

export function BrainOverview({
  state,
  workspaceId,
  companyProfileStatus,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  companyProfileStatus: { label: string; tone?: "default" | "warning" };
}) {
  const documents = documentStatus(state);
  const memory = memoryStatus(state);

  return (
    <div className="grid gap-6">
      <SummaryGroup title="Included automatically">
        <SummaryRow
          icon={<Building2Icon className="size-4" />}
          title="Company profile & goals"
          status={companyProfileStatus.label}
          tone={companyProfileStatus.tone}
          description="The essential company context every agent should know."
          action={
            <FocusAction view="company" workspaceId={workspaceId}>
              Manage
            </FocusAction>
          }
        />
        <SummaryRow
          icon={<BookOpenIcon className="size-4" />}
          title="Workspace instructions"
          status={workspaceInstructionStatus(state)}
          description="How agents should work in this workspace."
          action={
            <FocusAction view="instructions" workspaceId={workspaceId}>
              Review
            </FocusAction>
          }
        />
        <SummaryRow
          icon={<SlidersHorizontalIcon className="size-4" />}
          title="Preferences"
          status={`${state.preferences.activeDescriptorCount} active`}
          description="Short summaries are always known; full instructions are fetched when needed."
          tone={state.preferences.truncated ? "warning" : "default"}
          action={
            <FocusAction view="preferences" workspaceId={workspaceId}>
              Manage
            </FocusAction>
          }
        />
      </SummaryGroup>

      <SummaryGroup title="Available when needed">
        <SummaryRow
          icon={<FileSearchIcon className="size-4" />}
          title="Documents"
          status={documents.status}
          tone={documents.tone}
          description="Uploaded files and connected sources, kept within their selected scope."
          action={
            <RouteAction to="/workspaces/$workspaceId/documents" workspaceId={workspaceId}>
              Open
            </RouteAction>
          }
        />
        <SummaryRow
          icon={<BrainCircuitIcon className="size-4" />}
          title="Memory"
          status={memory.status}
          tone={memory.tone}
          description="Facts, decisions and observations learned across agent work."
          action={
            <RouteAction to="/workspaces/$workspaceId/memory" workspaceId={workspaceId}>
              Open
            </RouteAction>
          }
        />
      </SummaryGroup>
    </div>
  );
}
