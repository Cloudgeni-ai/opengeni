import type { WorkspaceStateGapCode, WorkspaceStateResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  BookOpenIcon,
  BrainCircuitIcon,
  CircleAlertIcon,
  Clock3Icon,
  FileSearchIcon,
  MapIcon,
  NetworkIcon,
  PlugIcon,
  ServerCogIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";

const GAP_LABELS: Record<WorkspaceStateGapCode, string> = {
  no_document_bases: "No document bases are configured.",
  no_visible_documents: "The visible document bases are empty.",
  failed_documents: "Some visible documents failed indexing.",
  processing_documents: "Some visible documents are queued or indexing.",
  missing_topic_coverage: "Ready documents do not have topic metadata.",
  no_memory_records: "The newest memory sample is empty.",
  pending_memory_review: "Some sampled memories are awaiting review.",
  partial_inventory:
    "The inventory reached a safety bound; shown counts cover only the inspected sample.",
};

function formatDate(value: string | null): string {
  if (!value) return "No activity";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function StateCard(props: { title: string; description?: string; children: ReactNode }) {
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

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-surface-2/40 p-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-fg">{value}</div>
    </div>
  );
}

function WorkspaceStateLoading() {
  return (
    <div aria-label="Loading workspace state" className="grid gap-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function PolicyInventory({ state }: { state: WorkspaceStateResponse }) {
  const { policy } = state;
  return (
    <StateCard
      title="Instruction policy inventory"
      description="Metadata from the authoritative instruction-policy backend. Policy bodies are intentionally excluded."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Active heads" value={policy.activeHeads.length} />
        <Metric
          label="Latest revision"
          value={policy.latestRevision ? `r${policy.latestRevision.revision}` : "None"}
        />
        <Metric
          label="Runtime source"
          value={
            policy.legacyRuntime.workspaceOverrideConfigured ? "Workspace override" : "Default"
          }
        />
      </div>

      <div className="mt-4 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-3 text-xs leading-5 text-fg-muted">
        <span className="font-medium text-fg">Current versus snapshot:</span> this is a read-time
        view. Runtime composition and immutable policy snapshots are not implemented, so active
        policy heads must not be interpreted as agent prompt truth.
      </div>

      {policy.latestRevision ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span className="rounded-full border border-border px-2 py-1">
            {humanize(policy.latestRevision.kind)} · {humanize(policy.latestRevision.scope)}
          </span>
          <span className="rounded-full border border-border px-2 py-1">
            {humanize(policy.latestRevision.state)}
          </span>
          <span className="rounded-full border border-border px-2 py-1">
            Provenance: {humanize(policy.latestRevision.provenanceSource)}
          </span>
        </div>
      ) : (
        <div className="mt-4">
          <EmptyState>No instruction-policy revisions exist yet.</EmptyState>
        </div>
      )}

      {policy.activeHeads.length > 0 ? (
        <div className="mt-4 divide-y divide-border rounded-md border border-border">
          {policy.activeHeads.map((head) => (
            <div
              key={`${head.kind}:${head.scope}:${head.roleKey ?? "global"}`}
              className="flex flex-col gap-1 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="font-medium text-fg">
                {humanize(head.kind)} · {head.roleKey ?? humanize(head.scope)}
              </div>
              <div className="text-fg-muted">
                r{head.revision} · activated {formatDate(head.activatedAt)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {policy.activeHeadsTruncated ? (
        <p className="mt-2 text-xs text-status-waiting">
          Only the first 32 active heads are shown.
        </p>
      ) : null}
    </StateCard>
  );
}

function KnowledgeInventory({
  state,
  workspaceId,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
}) {
  if (state.knowledge.availability === "unavailable") {
    return (
      <StateCard
        title="Knowledge map"
        description="Documents and Memory remain separate authorities."
      >
        <EmptyState>
          This inventory is unavailable because your grant does not include{" "}
          <code>documents:search</code>. No knowledge counts were disclosed.
        </EmptyState>
      </StateCard>
    );
  }

  const knowledge = state.knowledge;
  return (
    <StateCard
      title="Knowledge map"
      description="A structural view of visible Documents and the newest Memory sample; no document or memory text is returned."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Document bases" value={knowledge.baseCount} />
        <Metric label="Inspected documents" value={knowledge.inspectedVisibleDocumentCount} />
        <Metric label="Ready" value={knowledge.documentStatusCounts.ready} />
        <Metric label="Memory sample" value={knowledge.memorySample.recordCount} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1">
          <Clock3Icon className="size-3" /> Latest document{" "}
          {formatDate(knowledge.latestDocumentUpdatedAt)}
        </span>
        <span className="rounded-full border border-border px-2 py-1">
          Coverage: {humanize(knowledge.coverage)}
        </span>
        {knowledge.basesTruncated ? (
          <span className="rounded-full border border-status-waiting/50 px-2 py-1 text-status-waiting">
            Base list truncated
          </span>
        ) : null}
        {knowledge.memorySample.limitReached ? (
          <span className="rounded-full border border-status-waiting/50 px-2 py-1 text-status-waiting">
            Memory sample reached {knowledge.memorySample.sampleLimit}
          </span>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Bases</h3>
            <Link
              to="/workspaces/$workspaceId/documents"
              params={{ workspaceId }}
              className="text-xs font-medium text-brand hover:underline"
            >
              Open Documents
            </Link>
          </div>
          {knowledge.bases.length === 0 ? (
            <EmptyState>No document bases are visible.</EmptyState>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {knowledge.bases.map((base) => (
                <div key={base.id} className="p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-fg">{base.name}</span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {base.visibleDocumentCount} visible
                    </span>
                  </div>
                  <div className="mt-1 text-2xs text-fg-subtle">
                    {base.statusCounts.ready} ready ·{" "}
                    {base.statusCounts.indexing + base.statusCounts.queued} processing ·{" "}
                    {base.statusCounts.failed} failed
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Topics
          </h3>
          {knowledge.topics.length === 0 ? (
            <EmptyState>No topic metadata was found in the inspected documents.</EmptyState>
          ) : (
            <div className="flex flex-wrap gap-2 rounded-md border border-border p-3">
              {knowledge.topics.map((topic) => (
                <span
                  key={topic.name}
                  className="rounded-full border border-border bg-surface-2/50 px-2 py-1 text-xs text-fg-muted"
                >
                  {topic.name} · {topic.documentCount}
                </span>
              ))}
            </div>
          )}
          {knowledge.topicsTruncated ? (
            <p className="mt-2 text-xs text-status-waiting">Only the top 24 topics are shown.</p>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          Deterministic gap signals
        </h3>
        {knowledge.gaps.length === 0 ? (
          <EmptyState>No structural gaps were detected in the inspected inventory.</EmptyState>
        ) : (
          <ul className="grid gap-2">
            {knowledge.gaps.map((gap) => (
              <li
                key={gap.code}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-2/30 p-3 text-xs text-fg-muted"
              >
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
                <span>
                  {GAP_LABELS[gap.code]}
                  {gap.relatedCount === null ? "" : ` (${gap.relatedCount})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StateCard>
  );
}

function ExistingSources({ workspaceId }: { workspaceId: string }) {
  const links = [
    { to: "/workspaces/$workspaceId/documents" as const, label: "Documents", icon: FileSearchIcon },
    { to: "/workspaces/$workspaceId/memory" as const, label: "Memory", icon: BrainCircuitIcon },
    {
      to: "/workspaces/$workspaceId/capabilities" as const,
      label: "Skills & capabilities",
      icon: PlugIcon,
    },
    {
      to: "/workspaces/$workspaceId/sessions" as const,
      label: "Sessions & agents",
      icon: UsersIcon,
    },
    { to: "/workspaces/$workspaceId/rigs" as const, label: "Rigs", icon: ServerCogIcon },
    {
      to: "/workspaces/$workspaceId/variable-sets" as const,
      label: "Variable sets",
      icon: BookOpenIcon,
    },
    {
      to: "/workspaces/$workspaceId/settings" as const,
      label: "Workspace settings",
      icon: SettingsIcon,
    },
  ];
  return (
    <StateCard
      title="Authoritative source surfaces"
      description="Workspace State is an inventory, not a duplicate editor. Use the existing surfaces for detail and permitted changes."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ workspaceId }}
            className="flex items-center gap-2 rounded-md border border-border p-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
          >
            <item.icon className="size-4 text-brand" />
            {item.label}
          </Link>
        ))}
      </div>
    </StateCard>
  );
}

export function WorkspaceStateRoute({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const [state, setState] = useState<WorkspaceStateResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await client.getWorkspaceState(workspaceId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<MapIcon className="size-4" />}
        title="Workspace State"
        description="Read-only policy, knowledge, freshness, and coverage inventory from existing workspace authorities."
      />
      {loading && !state ? <WorkspaceStateLoading /> : null}
      {error && !state ? (
        <LoadErrorState
          title="Couldn't load workspace state"
          error={error}
          onRetry={() => void load()}
        />
      ) : null}
      {state ? (
        <div className="grid gap-4">
          {error ? (
            <LoadErrorState
              title="Couldn't refresh workspace state"
              error={error}
              onRetry={() => void load()}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/30 px-3 py-2 text-xs text-fg-muted">
            <NetworkIcon className="size-3.5 text-brand" />
            Generated {formatDate(state.generatedAt)} from a read-time projection. No background
            sweep or policy mutation ran.
          </div>
          <PolicyInventory state={state} />
          <KnowledgeInventory state={state} workspaceId={workspaceId} />
          <ExistingSources workspaceId={workspaceId} />
        </div>
      ) : null}
    </ContentPage>
  );
}
