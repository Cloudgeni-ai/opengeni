import type { WorkspaceModelAccessPolicy, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ModelsFormPage, RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, FieldStack, TextInput } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SettingRow, SettingRowSkeleton } from "@/components/ui/setting-row";
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

export function allowedModelsSummary(state: ModelAccessPolicyState): string {
  const draft = state.saved;
  if (!draft) return "";
  if (draft.mode === "unrestricted") return "All models from connected accounts";
  if (draft.mode === "provider") {
    const allowed = state.models.filter((model) => model.policyAllowed).length;
    return draft.policyVerdictComplete
      ? `Limited by provider: ${allowed} of ${state.models.length} models`
      : "Limited by provider";
  }
  const count = draft.selectedModelIds.size;
  return count === 0
    ? "No models: new work can't run"
    : count === 1
      ? "1 model"
      : `${count} models`;
}

/** The summary row on the Models page. */
export function AllowedModelsRow({
  state,
  canManage,
  onEdit,
}: {
  state: ModelAccessPolicyState;
  canManage: boolean;
  onEdit: () => void;
}) {
  if (state.loading && !state.saved) return <SettingRowSkeleton />;
  if (state.error) {
    return (
      <SettingRow
        label="Allowed models"
        error="Couldn't load Allowed models."
        control={
          <RowButton variant="ghost" onClick={() => void state.reload()}>
            Try again
          </RowButton>
        }
      />
    );
  }
  return (
    <SettingRow
      label="Allowed models"
      description={allowedModelsSummary(state)}
      control={
        <RowButton
          onClick={onEdit}
          aria-label={canManage ? "Edit allowed models" : "View allowed models"}
        >
          {canManage ? "Edit" : "View"}
        </RowButton>
      }
    />
  );
}

/** The form page. */
export function AllowedModelsFormPage({
  workspaceId,
  workspaceName,
  canManage,
  onClose,
}: {
  workspaceId: string;
  workspaceName?: string | undefined;
  canManage: boolean;
  onClose: () => void;
}) {
  const state = useModelAccessPolicy(workspaceId);
  const { models, saved } = state;
  const [draft, setDraft] = useState<ModelAccessPolicyDraft | null>(null);
  const [customModelId, setCustomModelId] = useState("");
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

  function addCustomModelId() {
    const modelId = customModelId.trim();
    if (!modelId) return;
    if (modelId.length > 256) {
      toast.error("That model ID is too long");
      return;
    }
    setModelSelected(modelId, true);
    setCustomModelId("");
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
      <FieldStack>
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
            Check the exact models below, then save to confirm the change.
          </Notice>
        ) : null}
        <ChoiceCards
          label="New work can use"
          value={draft.mode}
          disabled={disabled}
          onValueChange={(value) => setMode(value as "unrestricted" | "selected")}
        >
          <ChoiceCard
            value="unrestricted"
            title="All models from connected accounts"
            description="Includes models from accounts connected later, once they're ready."
          />
          <ChoiceCard
            value="selected"
            title="Only the models I choose"
            description="New models stay off until you add them here."
          />
        </ChoiceCards>
        {draft.mode === "selected" ? (
          <div role="group" aria-label="Models" className="flex min-w-0 flex-col gap-5">
            {groups.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Connect a subscription or API key to choose its models.
              </p>
            ) : (
              groups.map(([providerLabel, providerModels]) => (
                <fieldset key={providerLabel} className="m-0 min-w-0 border-0 p-0">
                  <legend className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">
                    {providerLabel}
                  </legend>
                  <div className="flex min-w-0 flex-col gap-3">
                    {providerModels.map((model) => (
                      <CheckboxField
                        key={model.id}
                        label={model.label}
                        description={<span className="font-mono">{model.id}</span>}
                        checked={draft.selectedModelIds.has(model.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) => setModelSelected(model.id, checked)}
                      />
                    ))}
                  </div>
                </fieldset>
              ))
            )}
            {customIds.length > 0 ? (
              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">
                  Other model IDs
                </legend>
                <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
                  {customIds.map((modelId) => (
                    <li
                      key={modelId}
                      className="flex min-h-9 min-w-0 items-center gap-2 rounded-[10px] bg-surface-2 pl-3"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                        {modelId}
                      </code>
                      {canManage ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${modelId}`}
                          onClick={() => setModelSelected(modelId, false)}
                          className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
                        >
                          <XIcon />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
            {canManage ? (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="allowed-models-add" className="text-sm font-medium text-fg">
                  Add a model ID
                </label>
                <div className="flex min-w-0 gap-2">
                  <TextInput
                    id="allowed-models-add"
                    mono
                    suppressAutofill
                    value={customModelId}
                    placeholder="provider/model"
                    aria-describedby="allowed-models-add-hint"
                    onChange={(event) => setCustomModelId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomModelId();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!customModelId.trim()}
                    onClick={addCustomModelId}
                    className="rounded-[10px] pointer-coarse:h-11"
                  >
                    <PlusIcon aria-hidden="true" />
                    Add
                  </Button>
                </div>
                <p id="allowed-models-add-hint" className="text-xs leading-4.5 text-fg-muted">
                  For a model that isn't connected yet. It can run once an account serves it.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </FieldStack>
    );
  }

  return (
    <>
      <ModelsFormPage
        title="Allowed models"
        description={`Which models new work in ${workspaceName ?? "this workspace"} may use, on top of what each account can serve. Work already running keeps its model.`}
        onClose={onClose}
        loading={state.loading && !saved}
        submitLabel="Save"
        pendingLabel="Saving…"
        submitDisabled={!canManage || !dirty || draft?.mode === "provider"}
        disabledReason={canManage ? undefined : "Only workspace admins can change Allowed models."}
        footerStart={
          draft && draft.mode !== "provider" ? (
            <span className="text-xs text-fg-muted">
              {draft.mode === "unrestricted"
                ? "All models allowed"
                : `${draft.selectedModelIds.size} model${draft.selectedModelIds.size === 1 ? "" : "s"} allowed`}
            </span>
          ) : null
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
