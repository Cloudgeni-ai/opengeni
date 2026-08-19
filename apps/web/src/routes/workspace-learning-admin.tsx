import type {
  GovernedLearningActivationReceipt,
  WorkspaceLearningHistoryResponse,
  WorkspaceLearningMode,
  WorkspaceLearningSourceOverrideInput,
} from "@opengeni/sdk";
import { PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, LoadErrorState } from "@/components/common";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

import { useWorkspaceLearningHistory } from "./workspace-state-loader";

const MODE_COPY: Record<WorkspaceLearningMode, { label: string; description: string }> = {
  off: {
    label: "Off",
    description: "Keep knowledge available, but do not derive durable behavioral changes.",
  },
  suggest: {
    label: "Review first",
    description: "Create auditable proposals and leave activation to a human reviewer.",
  },
  automatic: {
    label: "Autonomous",
    description: "Apply eligible high-confidence changes after stale, conflict, and ACL checks.",
  },
};

const REASON_COPY: Record<string, string> = {
  policy_off: "workspace policy is off",
  evidence_revoked: "source evidence was revoked",
  proposal_stale: "proposal baseline is stale",
  evidence_conflict: "supporting evidence conflicts",
  confidence_below_floor: "confidence is below the automatic threshold",
  policy_suggest: "workspace policy requires review",
  policy_automatic: "workspace policy permits guarded automatic activation",
};

type EditableSourceOverride = WorkspaceLearningSourceOverrideInput & { editorKey: string };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function revisionDiff(history: WorkspaceLearningHistoryResponse, revisionId: string): string[] {
  const revision = history.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) return [];
  const previous = history.revisions.find(
    (candidate) => candidate.id === revision.supersedesRevisionId,
  );
  const changes: string[] = [];
  if (!previous || previous.workspaceMode !== revision.workspaceMode) {
    changes.push(
      `${previous ? MODE_COPY[previous.workspaceMode].label : "Default off"} → ${MODE_COPY[revision.workspaceMode].label}`,
    );
  }
  const previousOverrides = new Map(
    (previous?.sourceOverrides ?? []).map((item) => [`${item.kind}\u0000${item.id}`, item.mode]),
  );
  const nextOverrides = new Map(
    revision.sourceOverrides.map((item) => [`${item.kind}\u0000${item.id}`, item.mode]),
  );
  for (const [key, mode] of nextOverrides) {
    if (previousOverrides.get(key) !== mode) {
      const [kind, id] = key.split("\u0000");
      changes.push(`${kind}/${shortId(id!)}: ${previousOverrides.get(key) ?? "inherit"} → ${mode}`);
    }
  }
  for (const [key, mode] of previousOverrides) {
    if (!nextOverrides.has(key)) {
      const [kind, id] = key.split("\u0000");
      changes.push(`${kind}/${shortId(id!)}: ${mode} → inherit`);
    }
  }
  return changes.slice(0, 12);
}

function canUndo(
  activation: GovernedLearningActivationReceipt,
  history: WorkspaceLearningHistoryResponse,
): boolean {
  return !history.undos.some((undo) => undo.activationReceiptId === activation.id);
}

export function WorkspaceLearningAdministration({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { client } = context;
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const history = useWorkspaceLearningHistory(client, workspaceId);
  const activeRevision = history.response?.revisions.find(
    (revision) => revision.id === history.response?.head?.revisionId,
  );
  const [mode, setMode] = useState<WorkspaceLearningMode>("off");
  const [overrides, setOverrides] = useState<EditableSourceOverride[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const overridesValid = overrides.every(
    (override) =>
      override.kind.trim().length > 0 &&
      override.id.trim().length > 0 &&
      override.id.trim() === override.id,
  );

  useEffect(() => {
    setMode(activeRevision?.workspaceMode ?? "off");
    setOverrides(
      (activeRevision?.sourceOverrides ?? []).map((override) => ({
        ...override,
        editorKey: `${override.kind}\u0000${override.id}`,
      })),
    );
  }, [activeRevision]);

  const timeline = useMemo(() => {
    if (!history.response) return [];
    return [
      ...history.response.policyEvents.map((event) => ({
        key: `policy:${event.id}`,
        at: event.createdAt,
        title: event.type === "rollback" ? "Learning mode rolled back" : "Learning mode activated",
        detail: `${MODE_COPY[history.response!.revisions.find((r) => r.id === event.newRevision.id)?.workspaceMode ?? "off"].label} · policy v${event.activationVersion} · human ${shortId(event.actorSubjectId)}`,
      })),
      ...history.response.decisions.map((decision) => ({
        key: `decision:${decision.id}`,
        at: decision.createdAt,
        title: `Decision: ${decision.outcome}`,
        detail: `${decision.sourceKind}/${shortId(decision.sourceId)} · ${(decision.confidenceBps / 100).toFixed(2)}% confidence · ${decision.reasons.map((reason) => REASON_COPY[reason] ?? reason).join(", ")}`,
      })),
      ...history.response.activations.map((activation) => ({
        key: `activation:${activation.id}`,
        at: activation.createdAt,
        title: `Automatic ${activation.destination.replace("_", " ")} activation`,
        detail: `${shortId(activation.sourceId)} · v${activation.destinationOldVersion} → v${activation.destinationNewVersion} · effective for the next accepted attempt`,
      })),
      ...history.response.undos.map((undo) => ({
        key: `undo:${undo.id}`,
        at: undo.createdAt,
        title: `Automatic ${undo.destination.replace("_", " ")} change undone`,
        detail: `v${undo.destinationOldVersion} → v${undo.destinationNewVersion} · exact-head compensation`,
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
  }, [history.response]);

  const save = async (): Promise<void> => {
    if (!canEdit || saving) return;
    setSaving(true);
    setMessage(null);
    setMutationError(null);
    try {
      const revision = await client.createWorkspaceLearningPolicyRevision(workspaceId, {
        operationId: crypto.randomUUID(),
        workspaceMode: mode,
        sourceOverrides: overrides.map(({ editorKey: _editorKey, ...override }) => override),
        supersedesRevisionId: history.response?.head?.revisionId ?? null,
      });
      await client.activateWorkspaceLearningPolicyRevision(workspaceId, revision.id, {
        operationId: crypto.randomUUID(),
        expectedCurrentRevisionId: history.response?.head?.revisionId ?? null,
        expectedActivationVersion: history.response?.head?.activationVersion ?? 0,
        reason: "Updated by a workspace admin from Learning & autonomy",
      });
      await history.reload();
      setMessage("Learning policy saved. It applies from the next accepted agent attempt.");
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (targetRevisionId: string): Promise<void> => {
    const head = history.response?.head;
    if (!canEdit || saving || !head) return;
    setSaving(true);
    setMessage(null);
    setMutationError(null);
    try {
      await client.rollbackWorkspaceLearningPolicyRevision(workspaceId, {
        operationId: crypto.randomUUID(),
        targetRevisionId,
        expectedCurrentRevisionId: head.revisionId,
        expectedActivationVersion: head.activationVersion,
        reason: "Rolled back by a workspace admin from Learning & autonomy",
      });
      await history.reload();
      setMessage("Learning policy rolled back for the next accepted attempt.");
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const undo = async (activationReceiptId: string): Promise<void> => {
    if (!canEdit || saving) return;
    setSaving(true);
    setMessage(null);
    setMutationError(null);
    try {
      await client.undoGovernedLearningActivation(workspaceId, activationReceiptId, {
        operationId: crypto.randomUUID(),
      });
      await history.reload();
      setMessage("Automatic change undone through its destination authority.");
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (history.loading && !history.response) {
    return (
      <div
        aria-label="Loading learning policy"
        className="h-48 animate-pulse rounded-lg bg-surface-2"
      />
    );
  }
  if (history.error && !history.response) {
    return (
      <LoadErrorState
        title="Couldn't load learning policy"
        error={history.error}
        onRetry={() => void history.reload()}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Learning mode</h2>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          Controls derived durable changes. Knowledge ingestion and retrieval stay separate.
        </p>
        <fieldset className="mt-4 grid gap-2 sm:grid-cols-3" disabled={!canEdit || saving}>
          <legend className="sr-only">Workspace learning mode</legend>
          {(Object.keys(MODE_COPY) as WorkspaceLearningMode[]).map((candidate) => (
            <label
              key={candidate}
              className="cursor-pointer rounded-md border border-border p-3 has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <input
                  type="radio"
                  name="learning-mode"
                  value={candidate}
                  checked={mode === candidate}
                  onChange={() => setMode(candidate)}
                />
                {MODE_COPY[candidate].label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-fg-muted">
                {MODE_COPY[candidate].description}
              </span>
            </label>
          ))}
        </fieldset>

        <details className="mt-4 rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg">
            Advanced source overrides
          </summary>
          <div className="grid gap-2 border-t border-border p-3">
            {overrides.map((override, index) => (
              <div
                key={override.editorKey}
                className="grid gap-2 sm:grid-cols-[1fr_2fr_10rem_auto]"
              >
                <input
                  aria-label={`Source kind ${index + 1}`}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs"
                  placeholder="source kind"
                  value={override.kind}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    setOverrides((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, kind: event.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  aria-label={`Source id ${index + 1}`}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs"
                  placeholder="exact source id"
                  value={override.id}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    setOverrides((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, id: event.target.value } : item,
                      ),
                    )
                  }
                />
                <select
                  aria-label={`Source mode ${index + 1}`}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs"
                  value={override.mode}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    setOverrides((items) =>
                      items.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              mode: event.target
                                .value as WorkspaceLearningSourceOverrideInput["mode"],
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="inherit">Inherit</option>
                  <option value="off">Off</option>
                  <option value="suggest">Review first</option>
                  <option value="automatic">Autonomous</option>
                </select>
                <button
                  type="button"
                  aria-label={`Remove source override ${index + 1}`}
                  className="rounded border border-border p-2 text-fg-muted hover:text-status-error"
                  disabled={!canEdit || saving}
                  onClick={() =>
                    setOverrides((items) => items.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-fg"
              disabled={!canEdit || saving}
              onClick={() =>
                setOverrides((items) => [
                  ...items,
                  { editorKey: crypto.randomUUID(), kind: "", id: "", mode: "inherit" },
                ])
              }
            >
              <PlusIcon className="size-3" />
              Add override
            </button>
          </div>
        </details>

        {!canEdit ? (
          <p className="mt-3 text-xs text-status-waiting">
            Workspace admin access is required to change learning policy.
          </p>
        ) : null}
        {!overridesValid ? (
          <p className="mt-3 text-xs text-status-waiting">
            Every source override needs a source kind and an exact ID without edge whitespace.
          </p>
        ) : null}
        {mutationError ? (
          <p role="alert" className="mt-3 text-xs text-status-error">
            {mutationError}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="mt-3 text-xs text-status-success">
            {message}
          </p>
        ) : null}
        <button
          type="button"
          className="mt-4 rounded-md bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          disabled={!canEdit || saving || !overridesValid}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save learning mode"}
        </button>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Policy versions</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Immutable revisions with bounded setting diffs. Rollback uses the exact current activation
          version.
        </p>
        {history.response?.revisions.length ? (
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {history.response.revisions.map((revision) => {
              const active = revision.id === history.response?.head?.revisionId;
              const changes = revisionDiff(history.response!, revision.id);
              return (
                <div key={revision.id} className="grid gap-2 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-fg">
                      r{revision.revision} · {MODE_COPY[revision.workspaceMode].label}
                      {active ? " · Active" : ""}
                    </span>
                    <span className="text-fg-muted">{formatDate(revision.createdAt)}</span>
                  </div>
                  <div className="text-fg-muted">
                    {revision.sourceOverrides.length} explicit source override(s) · human{" "}
                    {shortId(revision.createdBySubjectId)}
                  </div>
                  {changes.length ? (
                    <ul className="list-disc pl-4 text-fg-muted">
                      {changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  ) : null}
                  {!active && history.response?.head && canEdit ? (
                    <button
                      type="button"
                      className="inline-flex w-fit items-center gap-1 text-brand hover:underline disabled:opacity-60"
                      disabled={saving}
                      onClick={() => void rollback(revision.id)}
                    >
                      <RotateCcwIcon className="size-3" />
                      Rollback to r{revision.revision}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState>
              No learning-policy revisions exist. The effective default is Off.
            </EmptyState>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg">Learning history</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Content-free receipts cite exact source IDs, policy versions, confidence, reasons, actors,
          and effective boundaries. Private source text is excluded.
        </p>
        {timeline.length ? (
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {timeline.map((item) => (
              <div key={item.key} className="p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-fg">{item.title}</span>
                  <span className="text-fg-muted">{formatDate(item.at)}</span>
                </div>
                <p className="mt-1 break-words leading-5 text-fg-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState>No visible governed-learning receipts exist yet.</EmptyState>
          </div>
        )}
        {history.response?.activations.map((activation) =>
          canUndo(activation, history.response!) && canEdit ? (
            <button
              key={activation.id}
              type="button"
              className="mt-2 mr-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg disabled:opacity-60"
              disabled={saving}
              onClick={() => void undo(activation.id)}
            >
              <RotateCcwIcon className="size-3" />
              Undo {activation.destination.replace("_", " ")} change {shortId(activation.id)}
            </button>
          ) : null,
        )}
        {history.response?.truncated ? (
          <p className="mt-3 text-xs text-status-waiting">
            Only the newest 50 items from each immutable ledger are shown.
          </p>
        ) : null}
      </section>
    </div>
  );
}
