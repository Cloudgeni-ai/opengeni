// Knowledge bank: the workspace's living self-model — its charter (purpose +
// goals), the live knowledge map (bases, topics, memories), known gaps, and
// the charter version history. Deliberately sparse color: identity stays in
// neutral chips + text tokens, magnitude uses one brand-hue meter with the
// number beside it, and status always ships icon + text, never color alone.
import {
  AlertTriangleIcon,
  CheckIcon,
  HistoryIcon,
  LandmarkIcon,
  Loader2Icon,
  LockIcon,
  LockOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";
import type { KnowledgeBankResponse, WorkspaceCharter } from "@/types";

export function KnowledgeRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const [bank, setBank] = useState<KnowledgeBankResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editPurpose, setEditPurpose] = useState("");
  const [editGoals, setEditGoals] = useState("");
  const [versions, setVersions] = useState<WorkspaceCharter[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBank(await client.getKnowledgeBank(workspaceId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const charter = bank?.charter ?? null;
  const map = bank?.map ?? null;
  const locked = bank?.state?.locked === true;
  const maxBaseDocs = Math.max(1, ...(map?.bases.map((base) => base.documentCount) ?? [1]));
  const maxTopicCount = Math.max(1, ...(map?.topics.map((topic) => topic.count) ?? [1]));

  async function handleRefresh() {
    setRefreshing(true);
    try {
      setBank(await client.refreshKnowledgeBank(workspaceId));
      setVersions(null);
      toast.success("Knowledge bank refreshed", {
        description: "The charter was re-synthesized from current knowledge.",
      });
    } catch (cause) {
      toast.error("Refresh failed", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggleLock() {
    setTogglingLock(true);
    try {
      setBank(await client.updateKnowledgeBank(workspaceId, { locked: !locked }));
      toast.success(locked ? "Bank unlocked — sweeps may update it" : "Bank locked — humans only");
    } catch (cause) {
      toast.error("Failed to change lock", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setTogglingLock(false);
    }
  }

  function startEditing() {
    setEditPurpose(charter?.purpose ?? "");
    setEditGoals((charter?.goals ?? []).join("\n"));
    setEditing(true);
  }

  async function handleSaveEdit() {
    const purpose = editPurpose.trim();
    if (!purpose) return;
    setSaving(true);
    try {
      const goals = editGoals
        .split("\n")
        .map((goal) => goal.trim())
        .filter(Boolean);
      setBank(await client.updateKnowledgeBank(workspaceId, { purpose, goals }));
      setVersions(null);
      setEditing(false);
      toast.success("Charter updated", { description: "Saved as a new version." });
    } catch (cause) {
      toast.error("Failed to save charter", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleHistory() {
    if (versions !== null) {
      setVersions(null);
      return;
    }
    setVersionsLoading(true);
    try {
      const response = await client.getKnowledgeBankVersions(workspaceId, 20);
      setVersions(response.versions);
    } catch (cause) {
      toast.error("Failed to load history", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setVersionsLoading(false);
    }
  }

  return (
    <ContentPage>
      <section className="flex min-h-0 flex-1 flex-col text-left">
        <PageHeader
          icon={<LandmarkIcon className="size-4" />}
          title="Knowledge"
          description="What this workspace is for, what it knows, and what it's missing."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleToggleLock()}
                disabled={togglingLock || loading}
                className="h-8"
                title={
                  locked
                    ? "Locked: automatic synthesis will not overwrite the charter"
                    : "Unlocked: sweeps may update the charter"
                }
              >
                {togglingLock ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : locked ? (
                  <LockIcon className="size-3.5" />
                ) : (
                  <LockOpenIcon className="size-3.5" />
                )}
                {locked ? "Locked" : "Unlocked"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleRefresh()}
                disabled={refreshing || loading || locked}
                className="h-8"
              >
                {refreshing ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
                Refresh now
              </Button>
            </div>
          }
        />

        {loading ? (
          <div className="mt-6 flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-xs text-fg-muted">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading knowledge bank
          </div>
        ) : error ? (
          <div className="mt-6">
            <LoadErrorState
              title="Couldn't load the knowledge bank"
              error={error}
              onRetry={() => void load()}
            />
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            {/* Charter column */}
            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-border bg-surface/35 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs font-medium uppercase text-fg-subtle">Charter</div>
                  <div className="flex items-center gap-2 text-2xs text-fg-subtle">
                    {charter ? (
                      <>
                        v{charter.version} · {formatUpdatedBy(charter.updatedBy, charter.model)} ·{" "}
                        {relativeTime(charter.createdAt)}
                      </>
                    ) : null}
                    {editing ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={startEditing}
                        aria-label="Edit charter"
                        title="Edit purpose and goals"
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                {editing ? (
                  <div className="mt-3 grid gap-2">
                    <label className="grid gap-1 text-[11px] font-medium text-fg-subtle">
                      Purpose
                      <textarea
                        value={editPurpose}
                        onChange={(event) => setEditPurpose(event.target.value)}
                        rows={3}
                        className="w-full resize-y rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-2 text-sm leading-6 text-[color:var(--color-fg)]"
                      />
                    </label>
                    <label className="grid gap-1 text-[11px] font-medium text-fg-subtle">
                      Goals (one per line)
                      <textarea
                        value={editGoals}
                        onChange={(event) => setEditGoals(event.target.value)}
                        rows={5}
                        className="w-full resize-y rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-2 text-xs leading-5 text-[color:var(--color-fg)]"
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleSaveEdit()}
                        disabled={saving || !editPurpose.trim()}
                        className="h-8"
                      >
                        {saving ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <CheckIcon className="size-3.5" />
                        )}
                        Save as new version
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(false)}
                        disabled={saving}
                        className="h-8"
                      >
                        <XIcon className="size-3.5" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : charter ? (
                  <>
                    <p className="mt-2 text-sm leading-6 text-fg">{charter.purpose}</p>
                    {charter.goals.length > 0 ? (
                      <ul className="mt-3 space-y-1.5">
                        {charter.goals.map((goal) => (
                          <li
                            key={goal}
                            className="flex items-start gap-2 text-xs leading-5 text-fg-muted"
                          >
                            <CheckIcon className="mt-0.5 size-3 shrink-0 text-brand" />
                            {goal}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {charter.overview ? (
                      <p className="mt-3 border-t border-border pt-3 text-xs leading-5 text-fg-muted">
                        {charter.overview}
                      </p>
                    ) : null}
                    {charter.changelog ? (
                      <div className="mt-2 text-2xs text-fg-subtle">
                        Latest change: {charter.changelog}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <EmptyState
                    icon={<LandmarkIcon className="size-4" />}
                    title="No charter yet"
                    description="Drop documents or save memories, then refresh — the AI writes the first charter from what it finds."
                    action={
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleRefresh()}
                        disabled={refreshing}
                      >
                        {refreshing ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3.5" />
                        )}
                        Write the first charter
                      </Button>
                    }
                  />
                )}
              </section>

              {charter && charter.gaps.length > 0 ? (
                <Notice tone="waiting" title="Knowledge gaps">
                  <ul className="mt-1 space-y-1">
                    {charter.gaps.map((gap) => (
                      <li key={gap} className="flex items-start gap-2 text-xs leading-5">
                        <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                        {gap}
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : null}

              <section className="rounded-lg border border-border bg-surface/35 p-4">
                <button
                  type="button"
                  onClick={() => void handleToggleHistory()}
                  className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium uppercase text-fg-subtle"
                >
                  <span className="flex items-center gap-2">
                    <HistoryIcon className="size-3.5" />
                    Version history
                  </span>
                  {versionsLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                </button>
                {versions !== null ? (
                  <ol className="mt-3 space-y-2">
                    {versions.map((version) => (
                      <li
                        key={version.id}
                        className="rounded-md border border-border bg-bg/25 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-2xs text-fg-subtle">
                          <span>
                            v{version.version} · {formatUpdatedBy(version.updatedBy, version.model)}
                          </span>
                          <span>{relativeTime(version.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-xs leading-5 text-fg-muted">
                          {version.changelog ?? version.purpose.slice(0, 140)}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </section>
            </div>

            {/* Map column */}
            <div className="min-w-0 space-y-4">
              {map ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <StatTile label="Documents" value={map.totalReadyDocuments} />
                    <StatTile label="Bases" value={map.bases.length} />
                    <StatTile label="Memories" value={map.totalMemories} />
                  </div>

                  <section className="rounded-lg border border-border bg-surface/35 p-4">
                    <div className="text-xs font-medium uppercase text-fg-subtle">Bases</div>
                    <div className="mt-3 space-y-3">
                      {map.bases.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border p-3 text-xs leading-5 text-fg-muted">
                          No document bases yet. Drop something on the Documents page.
                        </div>
                      ) : (
                        map.bases.map((base) => {
                          const note = charter?.baseNotes.find(
                            (candidate) =>
                              candidate.baseId === base.id || candidate.name === base.name,
                          );
                          return (
                            <div key={base.id} className="min-w-0">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-sm font-medium text-fg">
                                  {base.name}
                                </span>
                                <span className="shrink-0 text-2xs text-fg-subtle">
                                  {base.documentCount} {base.documentCount === 1 ? "doc" : "docs"}
                                  {base.lastDocumentAt
                                    ? ` · ${relativeTime(base.lastDocumentAt)}`
                                    : ""}
                                </span>
                              </div>
                              {/* Single-hue magnitude meter; the number above is the label. */}
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg/60">
                                <div
                                  className="h-full rounded-full bg-brand/70"
                                  style={{
                                    width: `${Math.max(4, Math.round((base.documentCount / maxBaseDocs) * 100))}%`,
                                  }}
                                />
                              </div>
                              {note?.blurb ? (
                                <p className="mt-1 text-xs leading-5 text-fg-muted">{note.blurb}</p>
                              ) : null}
                              {base.topics.length > 0 ? (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {base.topics.slice(0, 6).map((topic) => (
                                    <span
                                      key={topic}
                                      className="rounded border border-border px-1 text-[11px] text-fg-subtle"
                                    >
                                      {topic}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </section>

                  {map.topics.length > 0 ? (
                    <section className="rounded-lg border border-border bg-surface/35 p-4">
                      <div className="text-xs font-medium uppercase text-fg-subtle">Topics</div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {map.topics.map((entry) => (
                          <span
                            key={entry.topic}
                            className={cn(
                              "rounded border border-border px-1.5 py-0.5 text-fg-muted",
                              entry.count / maxTopicCount > 0.66
                                ? "text-sm"
                                : entry.count / maxTopicCount > 0.33
                                  ? "text-xs"
                                  : "text-[11px]",
                            )}
                            title={`${entry.count} ${entry.count === 1 ? "document" : "documents"}`}
                          >
                            {entry.topic}
                            <span className="ml-1 text-2xs text-fg-subtle">{entry.count}</span>
                          </span>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {map.totalMemories > 0 ? (
                    <section className="rounded-lg border border-border bg-surface/35 p-4">
                      <div className="text-xs font-medium uppercase text-fg-subtle">Memories</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-fg-muted">
                        {Object.entries(map.memoriesByKind).map(([kind, count]) => (
                          <span key={kind} className="rounded border border-border px-1.5 py-0.5">
                            {kind}: {count}
                          </span>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {bank?.state?.lastError ? (
                    <Notice tone="failed" title="Last sweep failed">
                      <span className="flex items-start gap-2 text-xs leading-5">
                        <UnplugIcon className="mt-0.5 size-3 shrink-0" />
                        {bank.state.lastError}
                      </span>
                    </Notice>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </ContentPage>
  );
}

/** Hero number in text tokens — deliberately not a chart. */
function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface/35 px-3 py-2.5">
      <div className="text-lg font-semibold tabular-nums text-fg">{value}</div>
      <div className="text-2xs uppercase text-fg-subtle">{label}</div>
    </div>
  );
}

function formatUpdatedBy(updatedBy: string, model: string | null): string {
  if (updatedBy === "sweep") return model ? `AI sweep (${model})` : "AI sweep";
  if (updatedBy === "agent") return "agent proposal";
  return `edited by ${updatedBy}`;
}

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
