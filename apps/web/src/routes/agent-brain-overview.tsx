import type { WorkspaceStateGapCode, WorkspaceStateResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  Building2Icon,
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  FileSearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export type BrainProposalReview = {
  status: "loading" | "unavailable" | "ready";
  pendingCount: number;
  staleCount: number;
  partial: boolean;
};

export type BrainAttentionInput = {
  companyProfileStatus: { label: string; tone?: "default" | "warning" };
  workspaceInstructionsMissing: boolean;
  policyRevisionPending: boolean;
  policyInventoryPartial: boolean;
  preferenceInventoryPartial: boolean;
  inventoryRefreshFailed: boolean;
  knowledge:
    | { availability: "unavailable" }
    | {
        availability: "available";
        gaps: Array<{ code: WorkspaceStateGapCode; relatedCount: number | null }>;
      };
  proposals: BrainProposalReview;
};

const GAP_ATTENTION_LABELS: Record<WorkspaceStateGapCode, string> = {
  no_document_bases: "No document sources are configured",
  no_visible_documents: "No documents are visible",
  failed_documents: "Some documents failed indexing",
  processing_documents: "Some documents are still processing",
  missing_topic_coverage: "Some ready documents have no topics",
  no_memory_records: "No learned memory is visible",
  pending_memory_review: "Some learned memories await review",
  partial_inventory: "Knowledge review is partial",
};

function counted(label: string, count: number | null): string {
  return count && count > 0 ? `${label} (${count})` : label;
}

export function deriveBrainAttention(input: BrainAttentionInput): string[] {
  const attention: string[] = [];
  if (input.inventoryRefreshFailed) attention.push("Company Brain refresh failed");
  if (input.companyProfileStatus.tone === "warning") {
    attention.push("Company profile review is unavailable");
  } else if (input.companyProfileStatus.label === "Loading…") {
    attention.push("Company profile review is still loading");
  } else if (input.companyProfileStatus.label === "Not configured") {
    attention.push("Company profile is not set");
  }
  if (input.workspaceInstructionsMissing) attention.push("Workspace instructions are not set");
  if (input.policyRevisionPending) attention.push("An inactive policy revision needs review");
  if (input.policyInventoryPartial) attention.push("Policy review is partial");
  if (input.preferenceInventoryPartial) attention.push("Preference summaries are partially shown");
  if (input.knowledge.availability === "unavailable") {
    attention.push("Knowledge review is unavailable");
  } else {
    attention.push(
      ...input.knowledge.gaps.map((gap) =>
        counted(GAP_ATTENTION_LABELS[gap.code], gap.relatedCount),
      ),
    );
  }
  if (input.proposals.status === "unavailable") {
    attention.push("Proposal review is unavailable");
  } else if (input.proposals.status === "loading") {
    attention.push("Proposal review is still loading");
  } else {
    if (input.proposals.pendingCount > 0) {
      attention.push(
        `${input.proposals.pendingCount} proposal${input.proposals.pendingCount === 1 ? "" : "s"} await review`,
      );
    }
    if (input.proposals.staleCount > 0) {
      attention.push(
        `${input.proposals.staleCount} proposal${input.proposals.staleCount === 1 ? " has" : "s have"} a stale baseline`,
      );
    }
    if (input.proposals.partial) attention.push("Proposal review is partial");
  }
  return [...new Set(attention)];
}

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
  proposalReview,
  inventoryRefreshFailed = false,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  companyProfileStatus: { label: string; tone?: "default" | "warning" };
  proposalReview: BrainProposalReview;
  inventoryRefreshFailed?: boolean;
}) {
  const documents = documentStatus(state);
  const memory = memoryStatus(state);
  const attention = deriveBrainAttention({
    companyProfileStatus,
    workspaceInstructionsMissing: workspaceInstructionStatus(state) === "Not set",
    policyRevisionPending: state.policy.latestRevision?.state === "inactive",
    policyInventoryPartial: state.policy.activeHeadsTruncated,
    preferenceInventoryPartial: state.preferences.truncated,
    inventoryRefreshFailed,
    knowledge:
      state.knowledge.availability === "unavailable"
        ? { availability: "unavailable" }
        : { availability: "available", gaps: state.knowledge.gaps },
    proposals: proposalReview,
  });
  const recentChanges = [
    ...state.policy.activeHeads.map((head) => ({ label: "Rules", at: head.activatedAt })),
    ...(state.knowledge.availability === "available" && state.knowledge.latestDocumentUpdatedAt
      ? [{ label: "Knowledge", at: state.knowledge.latestDocumentUpdatedAt }]
      : []),
    ...(state.knowledge.availability === "available" && state.knowledge.memorySample.latestUpdatedAt
      ? [{ label: "Memory", at: state.knowledge.memorySample.latestUpdatedAt }]
      : []),
  ];
  recentChanges.sort((left, right) => right.at.localeCompare(left.at));

  return (
    <div className="grid gap-6">
      <SummaryGroup title="Always followed">
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
      </SummaryGroup>

      <SummaryGroup title="Available when needed">
        <SummaryRow
          icon={<SlidersHorizontalIcon className="size-4" />}
          title="Guides & preferences"
          status={`${state.preferences.activeDescriptorCount} active`}
          description="Short summaries are always known; full instructions are fetched when needed."
          tone={state.preferences.truncated ? "warning" : "default"}
          action={
            <FocusAction view="preferences" workspaceId={workspaceId}>
              Manage
            </FocusAction>
          }
        />
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

      <SummaryGroup title="Needs attention">
        {attention.length === 0 ? (
          <SummaryRow
            icon={<CheckCircle2Icon className="size-4" />}
            title="No visible review signals"
            status="Up to date"
            description="The loaded review authorities show no proposals, gaps, stale baselines, or partial projections."
          />
        ) : (
          attention.map((item) => (
            <SummaryRow
              key={item}
              icon={<CircleAlertIcon className="size-4" />}
              title={item}
              status="Review"
              tone="warning"
              description="Open the relevant Company Brain section to inspect the current authority."
            />
          ))
        )}
      </SummaryGroup>

      <SummaryGroup title="Recent changes">
        {recentChanges.length === 0 ? (
          <SummaryRow
            icon={<Clock3Icon className="size-4" />}
            title="No recent changes"
            status="Empty"
            description="No visible Company Brain change timestamps are available yet."
          />
        ) : (
          recentChanges
            .slice(0, 3)
            .map((change) => (
              <SummaryRow
                key={`${change.label}:${change.at}`}
                icon={<Clock3Icon className="size-4" />}
                title={change.label}
                status={new Date(change.at).toLocaleString()}
                description="Visible authority changed at this time. Open the relevant section for history."
              />
            ))
        )}
      </SummaryGroup>
    </div>
  );
}
