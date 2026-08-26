import type { WorkspaceStateGapCode, WorkspaceStateResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  FileSearchIcon,
  UserRoundIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { activeGlobalWorkspaceInstructionHead } from "@/lib/workspace-instructions";

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
  preferenceConflictCount: number;
  inventoryRefreshFailed: boolean;
  knowledge:
    | { availability: "unavailable" }
    | {
        availability: "available";
        gaps: Array<{
          code: WorkspaceStateGapCode;
          relatedCount: number | null;
        }>;
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
  if (input.inventoryRefreshFailed) attention.push("Agent Knowledge refresh failed");
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
  if (input.preferenceConflictCount > 0) {
    attention.push(
      `${input.preferenceConflictCount} active preference conflict${input.preferenceConflictCount === 1 ? " needs" : "s need"} review`,
    );
  }
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
  view: "instructions" | "skills";
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
  if (activeGlobalWorkspaceInstructionHead(state)) return "Set";
  if (state.policy.legacyRuntime.workspaceOverrideConfigured) {
    return "Custom instructions configured";
  }
  return "Not set";
}

function documentStatus(
  state: WorkspaceStateResponse,
  personalWorkspace: boolean,
): {
  status: string;
  tone: "default" | "warning";
} {
  if (state.knowledge.availability === "unavailable") {
    return { status: "Permission required", tone: "warning" };
  }

  const counts = state.knowledge.documentStatusCounts;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const needsAttention = counts.failed + counts.queued + counts.indexing;
  const parts = personalWorkspace
    ? [
        `${state.knowledge.authorityKindCounts.personal} personal`,
        `${total} available`,
        `${counts.ready} ready`,
      ]
    : [`${total} document${total === 1 ? "" : "s"}`, `${counts.ready} ready`];
  if (needsAttention > 0) parts.push(`${needsAttention} need attention`);
  if (state.knowledge.coverage === "partial") parts.push("partial view");
  return {
    status: parts.join(" · "),
    tone: needsAttention > 0 || state.knowledge.coverage === "partial" ? "warning" : "default",
  };
}

function memoryStatus(
  state: WorkspaceStateResponse,
  personalWorkspace: boolean,
): {
  status: string;
  tone: "default" | "warning";
} {
  if (state.knowledge.availability === "unavailable") {
    return { status: "Permission required", tone: "warning" };
  }
  const sample = state.knowledge.memorySample;
  const prefix = personalWorkspace ? "personal " : "recent ";
  return {
    status: sample.limitReached
      ? `${sample.recordCount}+ ${prefix}records`
      : `${sample.recordCount} ${prefix}record${sample.recordCount === 1 ? "" : "s"}`,
    tone: sample.limitReached ? "warning" : "default",
  };
}

export function BrainOverview({
  state,
  workspaceId,
  personalWorkspace = false,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  personalWorkspace?: boolean;
}) {
  const documents = documentStatus(state, personalWorkspace);
  const memory = memoryStatus(state, personalWorkspace);

  return (
    <div className="grid gap-6">
      {personalWorkspace ? (
        <section className="flex gap-3 rounded-lg border border-brand/25 bg-brand/5 p-4">
          <span className="self-start rounded-md bg-brand/10 p-2 text-brand">
            <UserRoundIcon className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-medium text-fg">Your personal workspace</h2>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Personal Skills and Only me documents belong to you and can follow you across the
              organization. Memory created here stays private inside this personal workspace. You
              can view the instruction currently applied here; personal instruction editing needs
              the upcoming personal-policy authority. Company knowledge remains labeled separately.
            </p>
          </div>
        </section>
      ) : null}
      <SummaryGroup title="How agents work">
        <SummaryRow
          icon={<BookOpenIcon className="size-4" />}
          title={personalWorkspace ? "Personal workspace instructions" : "Workspace instructions"}
          status={workspaceInstructionStatus(state)}
          description={
            personalWorkspace
              ? "Always-on guidance for agents working in your personal workspace."
              : "How agents should work in this workspace."
          }
          action={
            <FocusAction view="instructions" workspaceId={workspaceId}>
              {personalWorkspace ? "View" : "Review"}
            </FocusAction>
          }
        />
        <SummaryRow
          icon={<WandSparklesIcon className="size-4" />}
          title="Skills"
          status={
            personalWorkspace
              ? `${state.preferences.scopeCounts.user} personal · ${state.preferences.activeDescriptorCount} available`
              : `${state.preferences.activeDescriptorCount} active`
          }
          description={
            personalWorkspace
              ? "Your personal Skills follow you; company and workspace Skills remain available here."
              : "Reusable instructions agents fetch and follow when relevant."
          }
          tone={state.preferences.truncated ? "warning" : "default"}
          action={
            <FocusAction view="skills" workspaceId={workspaceId}>
              Manage
            </FocusAction>
          }
        />
      </SummaryGroup>

      <SummaryGroup title="What agents can find">
        <SummaryRow
          icon={<FileSearchIcon className="size-4" />}
          title="Documents"
          status={documents.status}
          tone={documents.tone}
          description={
            personalWorkspace
              ? "Your Only me documents, plus company knowledge you are allowed to use."
              : "Uploaded files and connected sources, kept within their selected scope."
          }
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
          description={
            personalWorkspace
              ? "Private facts, incidents, and decisions learned in your personal workspace."
              : "Facts, decisions and observations learned across agent work."
          }
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
