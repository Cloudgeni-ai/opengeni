import type { WorkspaceLearningMode, WorkspaceLearningSourceOverrideInput } from "@opengeni/sdk";
import { useEffect, useState } from "react";

import { LoadErrorState } from "@/components/common";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

import { useWorkspaceLearningHistory } from "./workspace-learning-loader";

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

export function WorkspaceLearningAdministration({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { client } = context;
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const history = useWorkspaceLearningHistory(client, workspaceId);
  const activeRevision = history.response?.revisions.find(
    (revision) => revision.id === history.response?.head?.revisionId,
  );
  const [mode, setMode] = useState<WorkspaceLearningMode>("off");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    setMode(activeRevision?.workspaceMode ?? "off");
  }, [activeRevision]);

  const save = async (nextMode: WorkspaceLearningMode): Promise<void> => {
    if (!canEdit || saving) return;
    setMode(nextMode);
    setSaving(true);
    setMessage(null);
    setMutationError(null);
    try {
      // Source overrides are no longer editable here; carry the active revision's
      // overrides forward unchanged so saving the mode never silently drops them.
      const sourceOverrides: WorkspaceLearningSourceOverrideInput[] = (
        activeRevision?.sourceOverrides ?? []
      ).map(({ kind, id, mode: overrideMode }) => ({ kind, id, mode: overrideMode }));
      const revision = await client.createWorkspaceLearningPolicyRevision(workspaceId, {
        operationId: crypto.randomUUID(),
        workspaceMode: nextMode,
        sourceOverrides,
        supersedesRevisionId: history.response?.head?.revisionId ?? null,
      });
      await client.activateWorkspaceLearningPolicyRevision(workspaceId, revision.id, {
        operationId: crypto.randomUUID(),
        expectedCurrentRevisionId: history.response?.head?.revisionId ?? null,
        expectedActivationVersion: history.response?.head?.activationVersion ?? 0,
        reason: "Updated by a workspace admin from Learning & autonomy",
      });
      await history.reload();
      setMessage("Learning mode saved. It applies from the next agent run.");
    } catch (error) {
      setMode(activeRevision?.workspaceMode ?? "off");
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
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">Learning & autonomy</h2>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        Controls derived Skills and workspace instructions. Agent Memory follows the separate
        Workspace memory toggle.
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
                onChange={() => void save(candidate)}
              />
              {MODE_COPY[candidate].label}
            </span>
            <span className="mt-1 block text-xs leading-5 text-fg-muted">
              {MODE_COPY[candidate].description}
            </span>
          </label>
        ))}
      </fieldset>

      {!canEdit ? (
        <p className="mt-3 text-xs text-status-waiting">
          Workspace admin access is required to change learning policy.
        </p>
      ) : null}
      {mutationError ? (
        <p role="alert" className="mt-3 text-xs text-status-error">
          {mutationError}
        </p>
      ) : null}
      {saving ? (
        <p role="status" className="mt-3 text-xs text-fg-muted">
          Saving learning mode…
        </p>
      ) : message ? (
        <p role="status" className="mt-3 text-xs text-status-success">
          {message}
        </p>
      ) : null}
    </section>
  );
}
