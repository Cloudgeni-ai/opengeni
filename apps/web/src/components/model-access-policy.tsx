import type { WorkspaceModelAccessPolicy, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { ChevronDownIcon, Loader2Icon, LockKeyholeIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";

export type ModelAccessPolicyDraft = {
  mode: "unrestricted" | "provider" | "selected";
  selectedModelIds: Set<string>;
  originalPolicy: WorkspaceModelAccessPolicy;
  policyVerdictComplete: boolean;
};

export function modelAccessPolicyDraft(
  policy: WorkspaceModelAccessPolicy,
  models: readonly WorkspaceModelCatalogModel[],
): ModelAccessPolicyDraft {
  if (policy.allowedProviders === null && policy.allowedModels === null) {
    return {
      mode: "unrestricted",
      selectedModelIds: new Set(models.map((model) => model.id)),
      originalPolicy: policy,
      policyVerdictComplete: true,
    };
  }

  if (policy.allowedProviders !== null) {
    const policyVerdictComplete = models.every((model) => typeof model.policyAllowed === "boolean");
    const catalogIds = new Set(models.map((model) => model.id));
    const selectedModelIds = new Set(
      models.filter((model) => model.policyAllowed).map((model) => model.id),
    );
    for (const modelId of policy.allowedModels ?? []) {
      if (!catalogIds.has(modelId)) selectedModelIds.add(modelId);
    }
    return {
      mode: "provider",
      selectedModelIds,
      originalPolicy: policy,
      policyVerdictComplete,
    };
  }

  return {
    mode: "selected",
    selectedModelIds: new Set(policy.allowedModels ?? []),
    originalPolicy: policy,
    policyVerdictComplete: true,
  };
}

export function modelAccessPolicyRequest(
  draft: ModelAccessPolicyDraft,
): WorkspaceModelAccessPolicy {
  if (draft.mode === "provider") return draft.originalPolicy;
  if (draft.mode === "unrestricted") {
    return { allowedProviders: null, allowedModels: null };
  }
  return {
    allowedProviders: null,
    allowedModels: [...draft.selectedModelIds].sort((left, right) => left.localeCompare(right)),
  };
}

function policyDraftKey(draft: ModelAccessPolicyDraft): string {
  return JSON.stringify(modelAccessPolicyRequest(draft));
}

function groupedModels(models: readonly WorkspaceModelCatalogModel[]) {
  const groups = new Map<string, WorkspaceModelCatalogModel[]>();
  for (const model of [...models].sort((left, right) => {
    const provider = left.providerLabel.localeCompare(right.providerLabel);
    return provider === 0 ? left.label.localeCompare(right.label) : provider;
  })) {
    const group = groups.get(model.providerLabel) ?? [];
    group.push(model);
    groups.set(model.providerLabel, group);
  }
  return [...groups.entries()];
}

export function ModelAccessPolicySection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [draft, setDraft] = useState<ModelAccessPolicyDraft | null>(null);
  const [savedKey, setSavedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [customModelId, setCustomModelId] = useState("");
  const [pendingReplacementMode, setPendingReplacementMode] = useState<
    "unrestricted" | "selected" | null
  >(null);
  const [open, setOpen] = useState(false);
  const loadGeneration = useRef(0);
  const scopeRef = useRef({ client, mounted: false, workspaceId });

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const [policy, catalog] = await Promise.all([
        client.getWorkspaceModelAccessPolicy(workspaceId),
        client.getWorkspaceModelCatalog(workspaceId),
      ]);
      if (generation !== loadGeneration.current) return;
      const next = modelAccessPolicyDraft(policy, catalog.models);
      setModels(catalog.models);
      setDraft(next);
      setSavedKey(policyDraftKey(next));
      setPendingReplacementMode(null);
    } catch (caught) {
      if (generation !== loadGeneration.current) return;
      setModels([]);
      setDraft(null);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    scopeRef.current = { client, mounted: true, workspaceId };
    void load();
    return () => {
      scopeRef.current.mounted = false;
      loadGeneration.current += 1;
    };
  }, [client, load, workspaceId]);

  const groups = useMemo(() => groupedModels(models), [models]);
  const catalogIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const customIds = useMemo(
    () =>
      draft
        ? [...draft.selectedModelIds]
            .filter((modelId) => !catalogIds.has(modelId))
            .sort((left, right) => left.localeCompare(right))
        : [],
    [catalogIds, draft],
  );
  const dirty = draft !== null && policyDraftKey(draft) !== savedKey;

  function setMode(mode: "unrestricted" | "selected") {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        mode,
        selectedModelIds:
          mode === "unrestricted"
            ? new Set(models.map((model) => model.id))
            : current.selectedModelIds,
      };
    });
  }

  function setModelSelected(modelId: string, selected: boolean) {
    setDraft((current) => {
      if (!current) return current;
      const next = new Set(current.selectedModelIds);
      if (selected) next.add(modelId);
      else next.delete(modelId);
      return { ...current, selectedModelIds: next };
    });
  }

  function addCustomModelId() {
    const modelId = customModelId.trim();
    if (!modelId) return;
    if (modelId.length > 256) {
      toast.error("Model ID is too long");
      return;
    }
    setModelSelected(modelId, true);
    setCustomModelId("");
  }

  async function save() {
    if (!draft || !canManage) return;
    const saveScope = { client, workspaceId };
    const isCurrentScope = () => {
      const current = scopeRef.current;
      return (
        current.mounted &&
        current.client === saveScope.client &&
        current.workspaceId === saveScope.workspaceId
      );
    };
    setSaving(true);
    try {
      await client.updateWorkspaceModelAccessPolicy(workspaceId, modelAccessPolicyRequest(draft));
      if (!isCurrentScope()) return;
      await load();
      if (!isCurrentScope()) return;
      toast.success("Model access updated");
    } catch (caught) {
      if (!isCurrentScope()) return;
      toast.error("Failed to update model access", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (isCurrentScope()) setSaving(false);
    }
  }

  const providerRestrictionActive = draft?.originalPolicy.allowedProviders !== null;
  const visiblePolicyAllowedCount = models.filter((model) => model.policyAllowed).length;
  const summaryStatus = error
    ? "Unavailable"
    : loading || !draft
      ? "…"
      : draft.mode === "unrestricted"
        ? "All models"
        : draft.mode === "selected"
          ? `${draft.selectedModelIds.size} selected`
          : draft.policyVerdictComplete
            ? `${visiblePolicyAllowedCount} of ${models.length}`
            : "Restricted";

  return (
    <section aria-labelledby="workspace-model-access-heading">
      <details
        className="group rounded-lg border border-border"
        open={open || error != null}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (error != null && !next) {
            event.currentTarget.open = true;
            return;
          }
          setOpen(next);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
          <LockKeyholeIcon className="size-3.5 shrink-0 text-brand" />
          <h2
            id="workspace-model-access-heading"
            className="min-w-0 flex-1 truncate text-sm font-medium"
          >
            Model access
          </h2>
          <span className="text-2xs text-fg-subtle">{summaryStatus}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
        </summary>

        <div className="grid gap-3 border-t border-border/70 px-3 py-3">
          {error ? (
            <LoadErrorState
              title="Couldn't load model access"
              error={error}
              onRetry={() => void load()}
            />
          ) : loading || !draft ? (
            <div className="grid gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : draft.mode === "provider" ? (
            <>
              {draft.policyVerdictComplete ? (
                <Notice tone="info" title="Provider-level restriction active">
                  {visiblePolicyAllowedCount} of {models.length} models allowed. Future models from
                  the same provider may also run.
                </Notice>
              ) : (
                <Notice tone="waiting" title="Refresh after the control plane update">
                  This browser does not yet have a complete model-policy projection. The existing
                  provider-level restriction remains unchanged, and replacement is disabled.
                </Notice>
              )}
              {canManage && draft.policyVerdictComplete ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setPendingReplacementMode("unrestricted")}
                  >
                    Allow all
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setPendingReplacementMode("selected")}
                  >
                    Choose exact models
                  </Button>
                </div>
              ) : (
                <span className="text-2xs text-fg-subtle">
                  {canManage
                    ? "Provider policy replacement unavailable"
                    : "Admin required to change"}
                </span>
              )}
            </>
          ) : (
            <>
              {providerRestrictionActive ? (
                <Notice
                  tone="waiting"
                  title="Provider-level restriction will be replaced"
                  action={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={saving}
                      onClick={() => {
                        const next = modelAccessPolicyDraft(draft.originalPolicy, models);
                        setDraft(next);
                      }}
                    >
                      Cancel
                    </Button>
                  }
                >
                  Save to replace the provider-wide rule with these IDs.
                </Notice>
              ) : null}

              <div className="grid gap-0.5">
                <label className="flex items-center gap-2 py-1">
                  <input
                    type="radio"
                    name={`model-access-${workspaceId}`}
                    checked={draft.mode === "unrestricted"}
                    disabled={!canManage || saving}
                    onChange={() => setMode("unrestricted")}
                    className="size-3.5 accent-brand"
                  />
                  <span className="text-sm">All models</span>
                </label>
                <label className="flex items-center gap-2 py-1">
                  <input
                    type="radio"
                    name={`model-access-${workspaceId}`}
                    checked={draft.mode === "selected"}
                    disabled={!canManage || saving}
                    onChange={() => setMode("selected")}
                    className="size-3.5 accent-brand"
                  />
                  <span className="text-sm">Selected models</span>
                </label>
              </div>

              {draft.mode === "selected" ? (
                <div className="grid gap-2">
                  {groups.length === 0 ? (
                    <p className="text-xs text-fg-subtle">No configured models are visible.</p>
                  ) : (
                    groups.map(([providerLabel, providerModels]) => (
                      <fieldset key={providerLabel} className="grid gap-0.5">
                        <legend className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                          {providerLabel}
                        </legend>
                        {providerModels.map((model) => (
                          <label
                            key={model.id}
                            title={model.id}
                            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2/60"
                          >
                            <input
                              type="checkbox"
                              checked={draft.selectedModelIds.has(model.id)}
                              disabled={!canManage || saving}
                              onChange={(event) => setModelSelected(model.id, event.target.checked)}
                              className="size-3.5 shrink-0 accent-brand"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm">{model.label}</span>
                            <span className="shrink-0 text-2xs text-fg-subtle">
                              {model.credentialReadiness.status === "ready" ? "Ready" : "Not ready"}
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    ))
                  )}

                  {customIds.length > 0 ? (
                    <div className="grid gap-0.5">
                      <div className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                        Other IDs
                      </div>
                      {customIds.map((modelId) => (
                        <div key={modelId} className="flex min-w-0 items-center gap-2 px-1 py-1">
                          <code className="min-w-0 flex-1 truncate text-xs">{modelId}</code>
                          {canManage ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={saving}
                              aria-label={`Remove ${modelId}`}
                              onClick={() => setModelSelected(modelId, false)}
                            >
                              <XIcon />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {canManage ? (
                    <form
                      className="flex min-w-0 gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        addCustomModelId();
                      }}
                    >
                      <Input
                        value={customModelId}
                        disabled={saving}
                        placeholder="Custom model ID"
                        aria-label="Add model ID"
                        className="h-8"
                        onChange={(event) => setCustomModelId(event.target.value)}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={saving || !customModelId.trim()}
                      >
                        <PlusIcon className="size-3.5" />
                        Add
                      </Button>
                    </form>
                  ) : null}
                </div>
              ) : null}

              {canManage ? (
                dirty || saving ? (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!dirty || saving}
                      onClick={() => void save()}
                    >
                      {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                      Save
                    </Button>
                  </div>
                ) : null
              ) : (
                <span className="text-2xs text-fg-subtle">Admin required to change</span>
              )}
            </>
          )}
        </div>
      </details>
      <ConfirmDialog
        open={pendingReplacementMode !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingReplacementMode(null);
        }}
        title="Replace the provider-level model policy?"
        description={
          pendingReplacementMode === "unrestricted"
            ? "This will allow all current and future configured models after you save."
            : "This will replace provider-wide access, including future models, with the exact model IDs currently permitted. You can review the list before saving."
        }
        confirmLabel="Replace policy"
        onConfirm={() => {
          if (!pendingReplacementMode) return false;
          setMode(pendingReplacementMode);
          setPendingReplacementMode(null);
          return true;
        }}
      />
    </section>
  );
}
