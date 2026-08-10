import type { WorkspaceStateResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  FileSearchIcon,
  HistoryIcon,
  NetworkIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";

function formatDate(value: string | null): string {
  if (!value) return "No activity";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function OverviewPanel(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">{props.title}</h2>
      {props.description ? (
        <p className="mt-1 text-xs leading-5 text-fg-muted">{props.description}</p>
      ) : null}
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

function AuthorityStatus(props: { children: ReactNode; tone?: "default" | "good" | "warning" }) {
  const tone = props.tone ?? "default";
  return (
    <span
      className={
        tone === "good"
          ? "rounded-full border border-status-success/30 bg-status-success/10 px-2 py-1 text-2xs font-medium text-status-success"
          : tone === "warning"
            ? "rounded-full border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-2xs font-medium text-status-waiting"
            : "rounded-full border border-border bg-surface-2/50 px-2 py-1 text-2xs font-medium text-fg-muted"
      }
    >
      {props.children}
    </span>
  );
}

function AuthorityCard(props: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  status: ReactNode;
  statusTone?: "default" | "good" | "warning";
  facts: Array<{ label: string; value: ReactNode }>;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="flex min-h-full flex-col rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-md border border-brand/20 bg-brand/10 p-2 text-brand">
            {props.icon}
          </span>
          <div className="min-w-0">
            <div className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">
              {props.eyebrow}
            </div>
            <h3 className="mt-1 text-sm font-semibold text-fg">{props.title}</h3>
          </div>
        </div>
        <AuthorityStatus tone={props.statusTone}>{props.status}</AuthorityStatus>
      </div>
      <p className="mt-3 text-xs leading-5 text-fg-muted">{props.description}</p>
      <dl className="mt-4 grid gap-2 rounded-md border border-border/70 bg-surface-2/30 p-3 text-xs">
        {props.facts.map((fact) => (
          <div key={fact.label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="font-medium text-fg-subtle">{fact.label}</dt>
            <dd className="min-w-0 text-fg-muted">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {props.children ? <div className="mt-3">{props.children}</div> : null}
      {props.action ? <div className="mt-auto pt-4">{props.action}</div> : null}
    </article>
  );
}

function DiagnosticsLink({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return (
    <a
      href="#brain-diagnostics"
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
      onClick={onOpen}
    >
      {children}
      <ArrowRightIcon className="size-3" />
    </a>
  );
}

function policyProjectedStatus(state: WorkspaceStateResponse): string {
  const count = state.policy.activeHeads.length;
  if (count === 0) return "No structured active heads";
  return state.policy.activeHeadsTruncated ? `${count}+ active heads · partial` : `${count} active`;
}

function policyScopeSummary(state: WorkspaceStateResponse): string {
  const globalCount = state.policy.activeHeads.filter((head) => head.scope === "global").length;
  const roleCount = state.policy.activeHeads.filter((head) => head.scope === "role").length;
  if (globalCount + roleCount === 0) return "No active structured targets";
  const suffix = state.policy.activeHeadsTruncated ? " · shown subset" : "";
  return `${globalCount} global · ${roleCount} role${suffix}`;
}

function sourceKindCount(state: WorkspaceStateResponse): number {
  if (state.knowledge.availability === "unavailable") return 0;
  return Object.values(state.knowledge.sourceKindCounts).filter((count) => count > 0).length;
}

export function BrainOverview({
  state,
  workspaceId,
  onOpenDiagnostics,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  onOpenDiagnostics: () => void;
}) {
  const knowledge = state.knowledge;
  const latestPolicyRevision = state.policy.latestRevision;
  const processingDocumentCount =
    knowledge.availability === "available"
      ? knowledge.documentStatusCounts.queued + knowledge.documentStatusCounts.indexing
      : 0;
  const visibleDocumentCount =
    knowledge.availability === "available"
      ? Object.values(knowledge.documentStatusCounts).reduce((total, count) => total + count, 0)
      : 0;
  const agentVisibleMemoryCount =
    knowledge.availability === "available"
      ? knowledge.memorySample.statusCounts.active + knowledge.memorySample.statusCounts.approved
      : 0;

  return (
    <div className="grid gap-5">
      <section
        aria-labelledby="agent-brain-model"
        className="rounded-lg border border-brand/20 bg-brand/5 p-4"
      >
        <div className="flex items-start gap-3">
          <span className="rounded-md bg-brand/10 p-2 text-brand">
            <NetworkIcon className="size-4" />
          </span>
          <div>
            <h2 id="agent-brain-model" className="text-sm font-semibold text-fg">
              Four authorities, two ways agents use them
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">
              Charter/policy and bounded preference descriptors are always-known governance.
              Documents and Memory stay separate and are retrieved only when relevant. This page
              projects those authorities; it is not another knowledge store and never merges or
              rewrites their content.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="always-known-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="always-known-heading" className="text-sm font-semibold text-fg">
              Always known
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Bounded mandatory context resolved at an accepted turn boundary.
            </p>
          </div>
          <ShieldCheckIcon className="size-4 text-brand" aria-hidden="true" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <AuthorityCard
            icon={<BookOpenIcon className="size-4" />}
            eyebrow="Mandatory context"
            title="Charter & policy"
            description="Workspace charter and policy context belongs to the versioned instruction-policy authority. This projection shows bounded active-head and revision metadata, but it cannot infer the composed runtime source or expose hidden prompt bodies."
            status={policyProjectedStatus(state)}
            statusTone={
              state.policy.activeHeadsTruncated
                ? "warning"
                : state.policy.activeHeads.length > 0
                  ? "good"
                  : "default"
            }
            facts={[
              { label: "Authority", value: "workspace_instruction_policy_heads" },
              { label: "Active scope", value: policyScopeSummary(state) },
              {
                label: "Latest revision",
                value: latestPolicyRevision
                  ? `r${latestPolicyRevision.revision} · ${humanize(latestPolicyRevision.state)}`
                  : "No revisions returned",
              },
              {
                label: "Latest provenance",
                value: latestPolicyRevision
                  ? `${humanize(latestPolicyRevision.provenanceSource)} · revision metadata only`
                  : "Unavailable",
              },
              {
                label: "Legacy configuration",
                value: state.policy.legacyRuntime.workspaceOverrideConfigured
                  ? "Workspace override configured"
                  : "Deployment default configured",
              },
              {
                label: "Runtime composition",
                value: "Not projected; no combined effective source is inferred",
              },
              {
                label: "Coverage",
                value: "Workspace charter/policy; organization profile is not projected here",
              },
            ]}
            action={
              <DiagnosticsLink onOpen={onOpenDiagnostics}>
                Inspect policy status and audit metadata
              </DiagnosticsLink>
            }
          >
            {state.policy.activeHeadsTruncated ? (
              <p className="text-xs leading-5 text-status-waiting">
                The active-head list reached its safety bound. Counts and scopes are a partial view.
              </p>
            ) : null}
          </AuthorityCard>
          <AuthorityCard
            icon={<BrainCircuitIcon className="size-4" />}
            eyebrow="Bounded descriptors"
            title="Preference Registry"
            description="Preferences, procedures, and working methods live in the structured registry. Agents receive bounded descriptors by default and retrieve the full body only when needed under accepted-turn authority."
            status={
              state.preferences.truncated
                ? `Partial · ${state.preferences.activeDescriptorCount} shown`
                : state.preferences.activeDescriptorCount > 0
                  ? `${state.preferences.activeDescriptorCount} active`
                  : "No active descriptors"
            }
            statusTone={
              state.preferences.truncated
                ? "warning"
                : state.preferences.activeDescriptorCount > 0
                  ? "good"
                  : "default"
            }
            facts={[
              { label: "Authority", value: "Structured preference registry" },
              {
                label: "Scope",
                value: `${state.preferences.scopeCounts.organization} organization · ${state.preferences.scopeCounts.workspace} workspace · ${state.preferences.scopeCounts.user} personal`,
              },
              {
                label: "Default context",
                value: "Bounded descriptor metadata plus exact retrieval handle",
              },
              { label: "Full content", value: "On demand; never loaded by this overview" },
            ]}
            action={
              <DiagnosticsLink onOpen={onOpenDiagnostics}>
                Inspect bounded registry metadata
              </DiagnosticsLink>
            }
          >
            {state.preferences.truncated ? (
              <p className="text-xs leading-5 text-status-waiting">
                The descriptor projection reached its safety bound, so this is a partial view.
              </p>
            ) : null}
          </AuthorityCard>
        </div>
      </section>

      <section aria-labelledby="retrieved-knowledge-heading">
        <div className="mb-3">
          <h2 id="retrieved-knowledge-heading" className="text-sm font-semibold text-fg">
            Retrieved when relevant
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Evidence and learned records remain searchable authorities, not mandatory prompt
            content.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <AuthorityCard
            icon={<FileSearchIcon className="size-4" />}
            eyebrow="Searchable evidence"
            title="Documents / RAG"
            description="Uploaded and connected content stays in Documents. Search results carry their immutable organization, workspace, or initiating-user authority and source provenance."
            status={
              knowledge.availability === "unavailable"
                ? "Unavailable · permission"
                : knowledge.coverage === "partial"
                  ? `Partial · ${knowledge.documentStatusCounts.ready} ready`
                  : visibleDocumentCount === 0
                    ? "Empty"
                    : processingDocumentCount > 0
                      ? `${knowledge.documentStatusCounts.ready} ready · ${processingDocumentCount} processing`
                      : knowledge.documentStatusCounts.failed > 0
                        ? `${knowledge.documentStatusCounts.ready} ready · ${knowledge.documentStatusCounts.failed} failed`
                        : `${knowledge.documentStatusCounts.ready} ready`
            }
            statusTone={
              knowledge.availability === "available" &&
              (knowledge.coverage === "partial" ||
                processingDocumentCount > 0 ||
                knowledge.documentStatusCounts.failed > 0)
                ? "warning"
                : knowledge.availability === "available" && visibleDocumentCount > 0
                  ? "good"
                  : "default"
            }
            facts={
              knowledge.availability === "available"
                ? [
                    {
                      label: "Scope",
                      value: `${knowledge.authorityKindCounts.organization} organization · ${knowledge.authorityKindCounts.workspace} workspace · ${knowledge.authorityKindCounts.personal} personal`,
                    },
                    {
                      label: "Indexing",
                      value: `${knowledge.documentStatusCounts.queued + knowledge.documentStatusCounts.indexing} processing · ${knowledge.documentStatusCounts.failed} failed`,
                    },
                    {
                      label: "Provenance",
                      value: `${sourceKindCount(state)} visible source types`,
                    },
                    {
                      label: "Freshness",
                      value: formatDate(knowledge.latestDocumentUpdatedAt),
                    },
                  ]
                : [
                    { label: "Scope", value: "Not disclosed without documents:search" },
                    { label: "Status", value: "No document or source counts were returned" },
                  ]
            }
            action={
              <Link
                to="/workspaces/$workspaceId/documents"
                params={{ workspaceId }}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Open Documents
                <ArrowRightIcon className="size-3" />
              </Link>
            }
          >
            {knowledge.availability === "available" && knowledge.coverage === "partial" ? (
              <p className="text-xs leading-5 text-status-waiting">
                The document inventory reached a safety bound. Counts, source types, and freshness
                are partial.
              </p>
            ) : null}
          </AuthorityCard>
          <AuthorityCard
            icon={<HistoryIcon className="size-4" />}
            eyebrow="Learned facts and decisions"
            title="Memory"
            description="Facts, decisions, observations, and history stay in Memory. The Brain shows only a bounded structural sample; record text, provenance, and correction chains remain on the Memory surface."
            status={
              knowledge.availability === "unavailable"
                ? "Unavailable · permission"
                : knowledge.memorySample.limitReached
                  ? `Partial sample · ${knowledge.memorySample.recordCount} shown`
                  : knowledge.memorySample.recordCount === 0
                    ? "Empty sample"
                    : `${agentVisibleMemoryCount} agent-visible in sample`
            }
            statusTone={
              knowledge.availability === "available" && knowledge.memorySample.limitReached
                ? "warning"
                : knowledge.availability === "available" && knowledge.memorySample.recordCount > 0
                  ? "good"
                  : "default"
            }
            facts={
              knowledge.availability === "available"
                ? [
                    {
                      label: "Sample",
                      value: `${knowledge.memorySample.recordCount} newest authorized records`,
                    },
                    {
                      label: "Kinds",
                      value: `${knowledge.memorySample.kindCounts.semantic} facts · ${knowledge.memorySample.kindCounts.decision} decisions · ${knowledge.memorySample.kindCounts.episodic} history`,
                    },
                    {
                      label: "Lifecycle",
                      value: `${knowledge.memorySample.statusCounts.proposed} proposed · ${knowledge.memorySample.statusCounts.superseded + knowledge.memorySample.statusCounts.archived} retired`,
                    },
                    {
                      label: "Freshness",
                      value: formatDate(knowledge.memorySample.latestUpdatedAt),
                    },
                  ]
                : [
                    { label: "Scope", value: "Authorized Memory metadata was not disclosed" },
                    { label: "Status", value: "Open Memory for your permitted records" },
                  ]
            }
            action={
              <Link
                to="/workspaces/$workspaceId/memory"
                params={{ workspaceId }}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Open Memory history
                <ArrowRightIcon className="size-3" />
              </Link>
            }
          >
            {knowledge.availability === "available" && knowledge.memorySample.limitReached ? (
              <p className="text-xs leading-5 text-status-waiting">
                The Memory sample reached {knowledge.memorySample.sampleLimit} records. Lifecycle,
                kind, and freshness values describe only this partial sample.
              </p>
            ) : null}
            {knowledge.availability === "available" &&
            knowledge.memorySample.kindCounts.preference > 0 ? (
              <p className="text-xs leading-5 text-status-waiting">
                {knowledge.memorySample.kindCounts.preference} legacy preference-like Memory
                record(s) are observations only. The Preference Registry remains authoritative.
              </p>
            ) : null}
          </AuthorityCard>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Brain change controls">
        <OverviewPanel
          title="Pending changes"
          description="Suggestions must remain inactive until an authorized authority-specific lifecycle accepts them."
        >
          <div className="rounded-md border border-border/70 bg-surface-2/30 p-3 text-xs leading-5 text-fg-muted">
            This projection does not yet expose a unified governed-learning suggestion queue.
            Existing instruction-policy onboarding drafts remain separate evidence under Advanced &
            diagnostics and must not be mistaken for active policy or automatic learning.
          </div>
          <div className="mt-3">
            <DiagnosticsLink onOpen={onOpenDiagnostics}>
              Review inactive policy draft evidence
            </DiagnosticsLink>
          </div>
        </OverviewPanel>
        <OverviewPanel
          title="History & rollback"
          description="Audit and rollback remain owned by each authority; the Brain never performs a cross-authority rollback."
        >
          <ul className="grid gap-2 text-xs text-fg-muted">
            <li className="rounded-md border border-border/70 bg-surface-2/30 p-3">
              <span className="font-medium text-fg">Charter & policy:</span> revision, activation,
              provenance, and accepted-attempt drift metadata are available in diagnostics.
            </li>
            <li className="rounded-md border border-border/70 bg-surface-2/30 p-3">
              <span className="font-medium text-fg">Preferences:</span> immutable registry lifecycle
              stays canonical, but this base projection exposes only bounded identities; no full
              body or rollback control is loaded here.
            </li>
            <li className="rounded-md border border-border/70 bg-surface-2/30 p-3">
              <span className="font-medium text-fg">Documents and Memory:</span> use their source
              surfaces for indexing evidence, corrections, supersession, and record-level history.
            </li>
          </ul>
        </OverviewPanel>
      </section>
    </div>
  );
}
