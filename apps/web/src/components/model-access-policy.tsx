import type { WorkspaceModelAccessPolicy, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ModelsFormPage, RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorMessage } from "@/components/ui/error-message";
import { Checkbox, TextInput } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import {
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
  SettingRowSkeleton,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppContext } from "@/context";

/* ----------------------------------------------------------------------------
   Allowed models: the one workspace-wide limit on which models new work may
   use, on top of every connected account. A summary row on the Models page
   opens a form page to change it.
   -------------------------------------------------------------------------- */

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

/** The saved policy and the catalog it applies to, reloaded when a connection changes. */
export function useModelAccessPolicy(workspaceId: string) {
  const client = useAppContext().client;
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [saved, setSaved] = useState<ModelAccessPolicyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
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
      setModels(catalog.models);
      setSaved(modelAccessPolicyDraft(policy, catalog.models));
    } catch (caught) {
      if (generation !== loadGeneration.current) return;
      setModels([]);
      setSaved(null);
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

  useEffect(() => {
    const changed = () => {
      void load();
    };
    window.addEventListener("model-connections-changed", changed);
    return () => window.removeEventListener("model-connections-changed", changed);
  }, [load]);

  /**
   * Saves, then re-reads. Resolves false when the page moved to another
   * workspace meanwhile (the result is ignored). Throws a user-facing error.
   */
  const save = useCallback(
    async (draft: ModelAccessPolicyDraft): Promise<boolean> => {
      const saveScope = { client, workspaceId };
      const isCurrentScope = () => {
        const current = scopeRef.current;
        return (
          current.mounted &&
          current.client === saveScope.client &&
          current.workspaceId === saveScope.workspaceId
        );
      };
      try {
        await client.updateWorkspaceModelAccessPolicy(workspaceId, modelAccessPolicyRequest(draft));
      } catch (caught) {
        if (!isCurrentScope()) return false;
        throw new Error(
          `Couldn't save Allowed models. ${caught instanceof Error ? caught.message : String(caught)}`,
          { cause: caught },
        );
      }
      if (!isCurrentScope()) return false;
      await load();
      if (!isCurrentScope()) return false;
      toast.success("Allowed models saved");
      return true;
    },
    [client, load, workspaceId],
  );

  return { models, saved, loading, error, reload: load, save };
}

export type ModelAccessPolicyState = ReturnType<typeof useModelAccessPolicy>;

/** The current value, short, for the Allowed models row: "All models", "3 models". */
export function allowedModelsSummary(state: ModelAccessPolicyState): string {
  const draft = state.saved;
  if (!draft) return "";
  if (draft.mode === "unrestricted") return "All models";
  if (draft.mode === "provider") {
    const allowed = state.models.filter((model) => model.policyAllowed).length;
    return draft.policyVerdictComplete
      ? `${allowed} of ${state.models.length} models`
      : "Limited by provider";
  }
  const count = draft.selectedModelIds.size;
  return count === 0 ? "No models" : count === 1 ? "1 model" : `${count} models`;
}

/** The Allowed models row on the Models page: opens its page. */
export function AllowedModelsRow({
  state,
  onEdit,
}: {
  state: ModelAccessPolicyState;
  onEdit: () => void;
}) {
  if (state.loading && !state.saved) return <SettingRowSkeleton />;
  if (state.error) {
    return (
      <SettingRow
        label="Allowed models"
        error="Couldn't load Allowed models."
        control={<RowButton onClick={() => void state.reload()}>Try again</RowButton>}
      />
    );
  }
  const blocked = state.saved?.mode === "selected" && state.saved.selectedModelIds.size === 0;
  return (
    <SettingNavRow
      label="Allowed models"
      description={
        blocked
          ? "No model is allowed, so new work can't start."
          : "The models people can pick for new chats and schedules."
      }
      value={allowedModelsSummary(state)}
      onOpen={onEdit}
    />
  );
}

/** The form page. */
export function AllowedModelsFormPage({
  workspaceId,
  canManage,
  onClose,
}: {
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const state = useModelAccessPolicy(workspaceId);
  const { models, saved } = state;
  const [draft, setDraft] = useState<ModelAccessPolicyDraft | null>(null);
  const [pendingReplacementMode, setPendingReplacementMode] = useState<
    "unrestricted" | "selected" | null
  >(null);

  // A fresh read (first load, or after a connection changed) resets the draft.
  useEffect(() => {
    setDraft(saved);
    setPendingReplacementMode(null);
  }, [saved]);

  const groups = useMemo(
    () => groupedModels(models.filter((model) => model.credentialReadiness.status === "ready")),
    [models],
  );
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
  const dirty = draft !== null && saved !== null && policyDraftKey(draft) !== policyDraftKey(saved);

  function setMode(mode: "unrestricted" | "selected") {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        mode,
        selectedModelIds:
          mode === "unrestricted"
            ? new Set(models.map((model) => model.id))
            : current.mode === "unrestricted"
              ? new Set(
                  models
                    .filter((model) => model.credentialReadiness.status === "ready")
                    .map((model) => model.id),
                )
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

  const providerRestrictionActive = draft?.originalPolicy.allowedProviders !== null;
  const visiblePolicyAllowedCount = models.filter((model) => model.policyAllowed).length;
  const disabled = !canManage;

  let body: ReactNode = null;
  if (state.error) {
    body = (
      <ErrorMessage
        title="Couldn't load Allowed models."
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void state.reload()}>
            Try again
          </Button>
        }
      >
        Nothing was changed.
      </ErrorMessage>
    );
  } else if (draft?.mode === "provider") {
    body = draft.policyVerdictComplete ? (
      <Notice
        tone="info"
        title="Limited to whole providers"
        action={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPendingReplacementMode("unrestricted")}
              >
                Allow all instead
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPendingReplacementMode("selected")}
              >
                Choose exact models
              </Button>
            </div>
          ) : undefined
        }
      >
        This workspace allows {visiblePolicyAllowedCount} of {models.length} models by provider, and
        may also allow future models from the same providers. It was set through the API; the
        providers themselves aren't shown here.
      </Notice>
    ) : (
      <Notice tone="waiting" title="Refresh after the update finishes">
        This browser doesn't have the full model list yet. The provider limit stays as it is, and it
        can't be replaced until you refresh.
      </Notice>
    );
  } else if (draft) {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        {providerRestrictionActive ? (
          <Notice
            tone="waiting"
            title="This replaces the provider limit"
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft(modelAccessPolicyDraft(draft.originalPolicy, models))}
              >
                Undo
              </Button>
            }
          >
            Check the models below, then save to confirm the change.
          </Notice>
        ) : null}
        <SettingRowGroup className="-mt-3">
          <SettingRow
            label="Allow every model"
            description="Includes models from accounts you connect later."
            control={
              <Switch
                checked={draft.mode === "unrestricted"}
                disabled={disabled}
                disabledReason={
                  disabled ? "Only workspace admins can change Allowed models." : undefined
                }
                onCheckedChange={(next) => setMode(next ? "unrestricted" : "selected")}
              />
            }
          />
        </SettingRowGroup>
        {draft.mode === "selected" ? (
          <ModelChecklist
            groups={groups}
            customIds={customIds}
            selected={draft.selectedModelIds}
            canManage={canManage}
            onToggle={setModelSelected}
            onAdd={(modelId) => setModelSelected(modelId, true)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <ModelsFormPage
        title="Allowed models"
        description="Choose which models people can pick for new chats and schedules."
        onClose={onClose}
        loading={state.loading && !saved}
        submitLabel="Save"
        pendingLabel="Saving…"
        submitDisabled={!canManage || !dirty || draft?.mode === "provider"}
        // The footer shows only while there is something to save.
        className={canManage && dirty ? undefined : "[&>form>footer]:hidden"}
        footerStart={
          draft && draft.mode !== "provider"
            ? draft.mode === "unrestricted"
              ? "Every model allowed"
              : `${draft.selectedModelIds.size} ${draft.selectedModelIds.size === 1 ? "model" : "models"} allowed`
            : null
        }
        onSubmit={async () => {
          if (!draft || !canManage) return false;
          return await state.save(draft);
        }}
        onSubmitted={onClose}
      >
        {body}
      </ModelsFormPage>
      <ConfirmDialog
        open={pendingReplacementMode !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingReplacementMode(null);
        }}
        title="Replace the provider limit?"
        description={
          pendingReplacementMode === "unrestricted"
            ? "After you save, every current and future model from connected accounts is allowed."
            : "After you save, only the exact models allowed today stay allowed; future models from the same providers don't. You can check the list before saving."
        }
        confirmLabel="Replace limit"
        onConfirm={() => {
          if (!pendingReplacementMode) return false;
          setMode(pendingReplacementMode);
          setPendingReplacementMode(null);
          return true;
        }}
      />
    </>
  );
}

/** At this many models the list gets a search field. */
const SEARCH_AT = 9;

/** Models grouped by provider, one row each, with a checkbox on the right. */
function ModelChecklist({
  groups,
  customIds,
  selected,
  canManage,
  onToggle,
  onAdd,
}: {
  groups: [string, WorkspaceModelCatalogModel[]][];
  customIds: string[];
  selected: Set<string>;
  canManage: boolean;
  onToggle: (modelId: string, selected: boolean) => void;
  onAdd: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [customModelId, setCustomModelId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const total = groups.reduce((count, [, models]) => count + models.length, 0);
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const shown = groups
    .map(
      ([label, models]) =>
        [
          label,
          models.filter((model) =>
            words.every((word) =>
              `${model.label} ${model.id} ${label}`.toLocaleLowerCase().includes(word),
            ),
          ),
        ] as const,
    )
    .filter(([, models]) => models.length > 0);

  useEffect(() => {
    if (adding) addInput.current?.focus();
  }, [adding]);

  function add() {
    const modelId = customModelId.trim();
    if (!modelId) return;
    if (modelId.length > 256) {
      setAddError("Use 256 characters or fewer.");
      return;
    }
    onAdd(modelId);
    setCustomModelId("");
    setAddError(null);
  }

  return (
    <div role="group" aria-label="Models" className="flex min-w-0 flex-col gap-5">
      {total >= SEARCH_AT ? (
        <label className="relative block min-w-0">
          <span className="sr-only">Search models</span>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <TextInput
            type="search"
            value={query}
            placeholder="Search models"
            suppressAutofill
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </label>
      ) : null}
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Connect a subscription or API key to choose its models.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-fg-muted">No models match “{query.trim()}”.</p>
      ) : (
        shown.map(([providerLabel, providerModels]) => (
          <ChecklistGroup key={providerLabel} label={providerLabel}>
            {providerModels.map((model) => (
              <li key={model.id} className="min-w-0">
                <label
                  title={model.id}
                  className={cn(
                    "-mx-3 flex min-h-11 min-w-0 items-center gap-3 rounded-[10px] px-3",
                    canManage
                      ? "cursor-pointer transition-colors duration-[120ms] hover:bg-surface-2"
                      : "opacity-80",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{model.label}</span>
                  <Checkbox
                    aria-label={model.label}
                    checked={selected.has(model.id)}
                    disabled={!canManage}
                    onCheckedChange={(checked) => onToggle(model.id, checked)}
                  />
                </label>
              </li>
            ))}
          </ChecklistGroup>
        ))
      )}
      {customIds.length > 0 ? (
        <ChecklistGroup label="Added by ID">
          {customIds.map((modelId) => (
            <li key={modelId} className="flex min-h-11 min-w-0 items-center gap-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{modelId}</code>
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${modelId}`}
                  onClick={() => onToggle(modelId, false)}
                  className="-mr-1.5 rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ChecklistGroup>
      ) : null}
      {canManage ? (
        adding ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="allowed-models-add" className="text-sm font-medium text-fg">
              Model ID
            </label>
            <div className="flex min-w-0 gap-2">
              <TextInput
                ref={addInput}
                id="allowed-models-add"
                mono
                suppressAutofill
                value={customModelId}
                placeholder="provider/model"
                aria-describedby="allowed-models-add-hint"
                aria-invalid={addError ? true : undefined}
                onChange={(event) => {
                  setCustomModelId(event.target.value);
                  setAddError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setAdding(false);
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!customModelId.trim()}
                onClick={add}
                className="h-9 rounded-[10px] pointer-coarse:h-11"
              >
                Add
              </Button>
            </div>
            <p
              id="allowed-models-add-hint"
              className={cn("text-xs leading-4.5", addError ? "text-danger" : "text-fg-muted")}
            >
              {addError ?? "For a model no account serves yet. It becomes usable once one does."}
            </p>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:min-h-11"
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              Add a model by ID
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

function ChecklistGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h3 id={id} className="pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
        {label}
      </h3>
      <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">{children}</ul>
    </section>
  );
}
