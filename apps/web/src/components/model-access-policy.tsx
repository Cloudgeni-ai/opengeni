import type { WorkspaceModelAccessPolicy, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  filterModelGroups,
  groupModelsByProvider,
  ModelGroup,
  MODEL_LIST_SEARCH_AT,
  ModelSearchField,
} from "@/components/models/model-list";
import { ModelsFormPage } from "@/components/models/models-ui";
import { RowButton } from "@/components/ui/page-actions";
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
import { userErrorText } from "@/lib/api-error";
import { modelUsesCredits, payerSummaryForModel } from "@/lib/model-policy";
import { cn } from "@/lib/utils";
import { useAppContext } from "@/context";
import type { OrganizationModelDefaultsState } from "@/components/models/use-organization-model-defaults";

/* ----------------------------------------------------------------------------
   Allowed models: the one limit on which models new work may use, on top of
   every connected account. The organization sets it once for every
   workspace; a workspace follows that until its admins give it its own list.
   A summary row on the Models page opens a form page to change it.

   Use Opengeni credits: a separate workspace switch (the `allowCreditModels`
   workspace setting). Off blocks every model paid with Opengeni credits,
   including credit models added later, without turning the allowlist into an
   exact list (which would also block subscription models connected later) and
   whichever list the workspace follows. It saves immediately from the Models
   page; the Allowed models form never sends it.
   -------------------------------------------------------------------------- */

export type ModelAccessPolicyDraft = {
  mode: "unrestricted" | "provider" | "selected";
  selectedModelIds: Set<string>;
  originalPolicy: WorkspaceModelAccessPolicy;
  policyVerdictComplete: boolean;
  /** A workspace that follows its organization's list rather than its own. */
  follow: boolean;
  /** The saved credit switch. Read-only here: only the switch row changes it. */
  allowCreditModels: boolean;
  /**
   * The catalog's `policyAllowed` verdicts come from a workspace with credits
   * off, so they mix the credit block into the allowlist's own verdict.
   */
  verdictBlocksCredits: boolean;
};

/** Whose list a page edits: one workspace's, or the organization's default. */
export type ModelPolicyScope =
  | { kind: "workspace"; workspaceId: string }
  | {
      kind: "organization";
      /** The workspace whose catalog lists the models to choose from. */
      workspaceId: string;
      defaults: OrganizationModelDefaultsState;
    };

const UNRESTRICTED = { allowedProviders: null, allowedModels: null } as const;

export function modelAccessPolicyDraft(
  policy: WorkspaceModelAccessPolicy,
  models: readonly WorkspaceModelCatalogModel[],
  verdictBlocksCredits = policy.allowCreditModels === false,
): ModelAccessPolicyDraft {
  // Older servers don't say where a policy comes from; treat it as the workspace's own.
  const follow = policy.source === "organization" || policy.source === "none";
  // Older servers omit the switch, and the organization's own list has none: credits stay allowed.
  const allowCreditModels = policy.allowCreditModels !== false;
  if (policy.allowedProviders === null && policy.allowedModels === null) {
    return {
      mode: "unrestricted",
      selectedModelIds: new Set(models.map((model) => model.id)),
      originalPolicy: policy,
      policyVerdictComplete: true,
      follow,
      allowCreditModels,
      verdictBlocksCredits,
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
      follow,
      allowCreditModels,
      verdictBlocksCredits,
    };
  }

  return {
    mode: "selected",
    selectedModelIds: new Set(policy.allowedModels ?? []),
    originalPolicy: policy,
    policyVerdictComplete: true,
    follow,
    allowCreditModels,
    verdictBlocksCredits,
  };
}

/** The organization's list a following workspace shows, as a draft. */
function organizationDraft(
  saved: ModelAccessPolicyDraft,
  models: readonly WorkspaceModelCatalogModel[],
): ModelAccessPolicyDraft {
  const organization = saved.originalPolicy.organization ?? UNRESTRICTED;
  return {
    ...modelAccessPolicyDraft(
      { ...organization, source: "organization", organization: saved.originalPolicy.organization },
      models,
    ),
    originalPolicy: saved.originalPolicy,
    allowCreditModels: saved.allowCreditModels,
    verdictBlocksCredits: saved.verdictBlocksCredits,
  };
}

export function modelAccessPolicyRequest(
  draft: ModelAccessPolicyDraft,
): WorkspaceModelAccessPolicy {
  if (draft.mode === "provider") {
    // A following workspace that unpins keeps the organization's provider list.
    const policy =
      draft.follow || draft.originalPolicy.source !== "organization"
        ? draft.originalPolicy
        : (draft.originalPolicy.organization ?? draft.originalPolicy);
    return { allowedProviders: policy.allowedProviders, allowedModels: policy.allowedModels };
  }
  if (draft.mode === "unrestricted") {
    return { allowedProviders: null, allowedModels: null };
  }
  return {
    allowedProviders: null,
    allowedModels: [...draft.selectedModelIds].sort((left, right) => left.localeCompare(right)),
  };
}

function policyDraftKey(draft: ModelAccessPolicyDraft): string {
  return JSON.stringify({ follow: draft.follow, policy: modelAccessPolicyRequest(draft) });
}

/** Whether the draft's allowlist lets this catalog model through (credits aside). */
function allowedByDraft(model: WorkspaceModelCatalogModel, draft: ModelAccessPolicyDraft) {
  if (draft.mode === "unrestricted") return true;
  // Opaque provider rules: the server's verdict is the only truth.
  if (draft.mode === "provider") return model.policyAllowed === true;
  return draft.selectedModelIds.has(model.id);
}

/**
 * How many connected models new work could still run on: ready, allowed by
 * the draft, and not paid with credits while credits are off. Zero means new
 * chats and schedules can't start.
 */
export function usableModelCount(
  models: readonly WorkspaceModelCatalogModel[],
  draft: ModelAccessPolicyDraft,
  allowCreditModels: boolean,
): number {
  return models.filter(
    (model) =>
      model.credentialReadiness.status === "ready" &&
      // Unrunnable for another reason (not entitled, unsupported, unhealthy).
      // A policy block is the saved list's verdict, which the draft replaces.
      (model.availability.selectable || model.availability.reason === "policy_blocked") &&
      allowedByDraft(model, draft) &&
      (allowCreditModels || !modelUsesCredits(model)),
  ).length;
}

/**
 * The credit switch shows when credits pay for any model here, or it is
 * already off. A server that doesn't report the switch can't enforce it, so it
 * never shows there: saving it would store a value nothing honours yet.
 */
export function creditSwitchVisible(
  models: readonly WorkspaceModelCatalogModel[],
  draft: ModelAccessPolicyDraft | null,
): boolean {
  if (!draft || typeof draft.originalPolicy.allowCreditModels !== "boolean") return false;
  return !draft.allowCreditModels || models.some((model) => modelUsesCredits(model));
}

/** The saved policy and the catalog it applies to, reloaded when a connection changes. */
export function useModelAccessPolicy(scopeOrWorkspaceId: string | ModelPolicyScope) {
  const scope: ModelPolicyScope =
    typeof scopeOrWorkspaceId === "string"
      ? { kind: "workspace", workspaceId: scopeOrWorkspaceId }
      : scopeOrWorkspaceId;
  const workspaceId = scope.workspaceId;
  const organizationDefaults = scope.kind === "organization" ? scope.defaults : null;
  const organizationPolicy = organizationDefaults?.defaults ?? null;
  const organizationKey = organizationDefaults
    ? JSON.stringify([
        organizationDefaults.loading,
        Boolean(organizationDefaults.error),
        organizationPolicy?.allowedProviders,
        organizationPolicy?.allowedModels,
      ])
    : "";
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
    // The organization's list arrives with its defaults; wait for them.
    if (organizationDefaults?.loading) return;
    try {
      const [policy, catalog, hostCreditsOff] = await Promise.all([
        organizationDefaults
          ? Promise.resolve<WorkspaceModelAccessPolicy | null>(
              organizationPolicy && {
                allowedProviders: organizationPolicy.allowedProviders,
                allowedModels: organizationPolicy.allowedModels,
              },
            )
          : client.getWorkspaceModelAccessPolicy(workspaceId),
        client.getWorkspaceModelCatalog(workspaceId),
        // The organization's list is shown through this workspace's catalog,
        // whose verdicts include this workspace's own credit switch.
        organizationDefaults
          ? client
              .getWorkspaceModelAccessPolicy(workspaceId)
              .then((hosting) => hosting.allowCreditModels === false)
              // Fail closed: an unknown switch hides "Choose exact models".
              .catch(() => true)
          : Promise.resolve(false),
      ]);
      if (generation !== loadGeneration.current) return;
      setModels(catalog.models);
      setSaved(
        policy
          ? modelAccessPolicyDraft(
              policy,
              catalog.models,
              organizationDefaults ? hostCreditsOff : undefined,
            )
          : null,
      );
      if (!policy && organizationDefaults?.error) throw organizationDefaults.error;
    } catch (caught) {
      if (generation !== loadGeneration.current) return;
      setModels([]);
      setSaved(null);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
    // Reload when the organization's saved list changes, not on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the saved values
  }, [client, workspaceId, organizationKey]);

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
   * workspace meanwhile (the result is ignored). Throws the failure for the form page to show.
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
        if (organizationDefaults) {
          await organizationDefaults.update({ modelPolicy: modelAccessPolicyRequest(draft) });
        } else if (draft.follow) {
          await client.deleteWorkspaceModelAccessPolicy(workspaceId);
        } else {
          await client.updateWorkspaceModelAccessPolicy(
            workspaceId,
            modelAccessPolicyRequest(draft),
          );
        }
      } catch (caught) {
        if (!isCurrentScope()) return false;
        // The form page says what to do and keeps an API error's facts in Technical details.
        throw caught instanceof Error && caught.message
          ? caught
          : new Error("Couldn't save Allowed models. Try again.", { cause: caught });
      }
      if (!isCurrentScope()) return false;
      await load();
      if (!isCurrentScope()) return false;
      toast.success("Allowed models saved");
      return true;
    },
    [client, load, organizationDefaults, workspaceId],
  );

  /**
   * Saves the workspace credit switch on its own (a workspace setting, so the
   * allowlists and whose list the workspace follows stay as they are), then
   * re-reads. Throws the failure for the switch row to show.
   */
  const setAllowCreditModels = useCallback(
    async (allowCreditModels: boolean): Promise<boolean> => {
      if (organizationDefaults) return false;
      const saveScope = { client, workspaceId };
      const isCurrentScope = () => {
        const current = scopeRef.current;
        return (
          current.mounted &&
          current.client === saveScope.client &&
          current.workspaceId === saveScope.workspaceId
        );
      };
      // The row only shows when this server reports (and so enforces) the switch.
      await client.updateWorkspaceSettings(workspaceId, { allowCreditModels });
      if (!isCurrentScope()) return false;
      // The switch shows the saved value before the success toast. A failed
      // re-read shows on the page itself, never as a failed change.
      await load();
      if (!isCurrentScope()) return false;
      // Every other model picker on the page re-reads the policy and catalog.
      window.dispatchEvent(new Event("model-connections-changed"));
      toast.success(
        allowCreditModels ? "Opengeni credits turned on" : "Opengeni credits turned off",
      );
      return true;
    },
    [client, load, organizationDefaults, workspaceId],
  );

  return {
    scope: scope.kind,
    models,
    saved,
    loading: loading || Boolean(organizationDefaults?.loading),
    error,
    reload: load,
    save,
    setAllowCreditModels,
  };
}

export type ModelAccessPolicyState = ReturnType<typeof useModelAccessPolicy>;

/** The current value, short, for the Allowed models row: "All models", "3 models". */
export function allowedModelsSummary(
  state: Pick<ModelAccessPolicyState, "saved" | "models">,
): string {
  const draft = state.saved;
  if (!draft) return "";
  if (draft.mode === "unrestricted") {
    return draft.allowCreditModels ? "All models" : "All except credits";
  }
  if (draft.mode === "provider") {
    // With credits off, the verdict mixes in the credit block: no count.
    if (!draft.policyVerdictComplete || draft.verdictBlocksCredits) return "Limited by provider";
    const allowed = state.models.filter((model) => model.policyAllowed).length;
    return `${allowed} of ${state.models.length} models`;
  }
  // With credits off, a listed credit model can't run: count only the rest.
  const byId = new Map(state.models.map((model) => [model.id, model]));
  const count = draft.allowCreditModels
    ? draft.selectedModelIds.size
    : [...draft.selectedModelIds].filter((id) => !modelUsesCredits(byId.get(id))).length;
  return count === 0 ? "No models" : count === 1 ? "1 model" : `${count} models`;
}

/**
 * Where a workspace's list comes from, in words, or null when the server
 * doesn't say (or this is the organization's own list).
 */
export function allowedModelsSource(
  state: Pick<ModelAccessPolicyState, "saved" | "scope">,
  organizationName: string | undefined,
): string | null {
  const saved = state.saved;
  if (state.scope !== "workspace" || !saved?.originalPolicy.source || !organizationName) {
    return null;
  }
  return saved.follow ? `Following ${organizationName}.` : "Changed for this workspace.";
}

/** The Allowed models row on the Models page: opens its page. */
export function AllowedModelsRow({
  state,
  onEdit,
  organizationName,
}: {
  state: ModelAccessPolicyState;
  onEdit: () => void;
  /** Names what a workspace follows; omit on the organization's own row. */
  organizationName?: string | undefined;
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
  const saved = state.saved;
  const blocked = saved?.mode === "selected" && saved.selectedModelIds.size === 0;
  const creditsLeaveNothing =
    saved !== null &&
    !saved.allowCreditModels &&
    usableModelCount(state.models, saved, false) === 0;
  const source = allowedModelsSource(state, organizationName);
  return (
    <SettingNavRow
      label="Allowed models"
      description={
        blocked
          ? state.scope === "organization"
            ? "No model is allowed, so workspaces that follow this can't start new work."
            : "No model is allowed, so new work can't start."
          : creditsLeaveNothing
            ? "Opengeni credits are off and no other model can run, so new work can't start."
            : source
              ? `The models people can pick for new chats and schedules. ${source}`
              : "The models people can pick for new chats and schedules."
      }
      value={allowedModelsSummary(state)}
      onOpen={onEdit}
    />
  );
}

/**
 * "Use Opengeni credits" on a workspace's Models page: one switch that blocks
 * every model paid with credits here, now and later, whichever allowlist the
 * workspace follows. Saves immediately; asks first only when turning it off
 * would leave no model new work can run on.
 */
export function OpengeniCreditsSwitchRow({
  state,
  canManage,
}: {
  state: ModelAccessPolicyState;
  canManage: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const saved = state.saved;
  if (state.scope !== "workspace" || !saved || state.error) return null;
  if (!creditSwitchVisible(state.models, saved)) return null;

  async function apply(next: boolean): Promise<boolean> {
    setPending(true);
    try {
      await state.setAllowCreditModels(next);
      return true;
    } catch (caught) {
      toast.error(userErrorText(caught, "Couldn't change Opengeni credits. Try again."));
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <SettingRow
        label="Use Opengeni credits"
        description="Lets people run models paid with Opengeni credits. Off blocks them here, including ones added later; subscriptions and API keys keep working."
        control={
          <Switch
            checked={saved.allowCreditModels}
            disabled={!canManage || pending}
            disabledReason={
              canManage ? undefined : "Only workspace admins can change Opengeni credits."
            }
            onCheckedChange={(next) => {
              if (!next && usableModelCount(state.models, saved, false) === 0) {
                setConfirmingOff(true);
                return;
              }
              void apply(next);
            }}
          />
        }
      />
      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title="Turn off Opengeni credits?"
        description="No other model can run in this workspace, so new chats and schedules won't start until you connect a subscription or an API key."
        confirmLabel="Turn off credits"
        pendingLabel="Turning off…"
        destructive={false}
        onConfirm={async () => await apply(false)}
      />
    </>
  );
}

/** The form page, for one workspace or for the organization's default. */
export function AllowedModelsFormPage({
  workspaceId,
  canManage,
  onClose,
  organizationName,
  organizationDefaults,
}: {
  /** The workspace whose list this edits, or whose catalog the organization's list uses. */
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
  /** Names the organization a workspace can follow. */
  organizationName?: string | undefined;
  /** Edit the organization's default instead of one workspace's list. */
  organizationDefaults?: OrganizationModelDefaultsState | undefined;
}) {
  const state = useModelAccessPolicy(
    organizationDefaults
      ? { kind: "organization", workspaceId, defaults: organizationDefaults }
      : { kind: "workspace", workspaceId },
  );
  const organizationScope = Boolean(organizationDefaults);
  // A workspace can follow its organization once the server reports where its list comes from.
  const canFollow = !organizationScope && Boolean(state.saved?.originalPolicy.source);
  const organizationLabel = organizationName ?? "your organization";
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
    () =>
      groupModelsByProvider(models.filter((model) => model.credentialReadiness.status === "ready")),
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

  function setModelsSelected(modelIds: readonly string[], selected: boolean) {
    setDraft((current) => {
      if (!current) return current;
      const next = new Set(current.selectedModelIds);
      for (const modelId of modelIds) {
        if (selected) next.add(modelId);
        else next.delete(modelId);
      }
      return { ...current, selectedModelIds: next };
    });
  }

  function setModelSelected(modelId: string, selected: boolean) {
    setModelsSelected([modelId], selected);
  }

  // The credit switch is the workspace's own; the organization's list has none.
  const creditsOff = !organizationScope && saved !== null && !saved.allowCreditModels;
  const nothingUsable =
    draft !== null &&
    draft.mode !== "provider" &&
    groups.length > 0 &&
    usableModelCount(models, draft, !creditsOff) === 0;

  // Choosing exact models replaces a provider limit; say so before saving.
  const providerRestrictionActive =
    draft !== null && !draft.follow && draft.originalPolicy.allowedProviders !== null;
  const visiblePolicyAllowedCount = models.filter((model) => model.policyAllowed).length;
  const following = canFollow && draft?.follow === true;
  const disabled = !canManage || following;

  function setFollow(follow: boolean) {
    setDraft((current) => {
      if (!current || !saved) return current;
      // Following shows the organization's list; changing it starts from that list.
      return follow
        ? { ...organizationDraft(saved, models), follow: true }
        : { ...current, follow: false };
    });
  }

  const followRow = canFollow ? (
    <SettingRowGroup className="-mt-3">
      <SettingRow
        label={`Use ${organizationLabel}’s allowed models`}
        description={
          following
            ? `Changes ${organizationLabel} makes apply here too. Turn this off to choose this workspace’s own models.`
            : "This workspace has its own list."
        }
        control={
          <Switch
            checked={following}
            disabled={!canManage}
            disabledReason={
              !canManage ? "Only workspace admins can change Allowed models." : undefined
            }
            onCheckedChange={setFollow}
          />
        }
      />
    </SettingRowGroup>
  ) : null;

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
  } else if (draft?.mode === "provider" && organizationScope) {
    body = (
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
              {/* This workspace's credit block is mixed into the verdicts, so an
                  exact list built from them would drop every credit model. */}
              {draft.verdictBlocksCredits ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingReplacementMode("selected")}
                >
                  Choose exact models
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {organizationLabel} allows models by provider, including future models from the same
        providers. It was set through the API; the providers themselves aren't shown here.
        {draft.verdictBlocksCredits
          ? " Opengeni credits are off in this workspace, so choose exact models from a workspace with credits on."
          : null}
      </Notice>
    );
  } else if (draft?.mode === "provider") {
    const providerNotice = draft.policyVerdictComplete ? (
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
              {/* With credits off the server's verdict can't tell a provider
                  block from a credit block, so an exact list built from it
                  would silently drop credit models. */}
              {draft.verdictBlocksCredits ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingReplacementMode("selected")}
                >
                  Choose exact models
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {creditsOff
          ? `${following ? organizationLabel : "This workspace"} limits models by provider, and may also allow future models from the same providers. It was set through the API; the providers themselves aren't shown here. Turn Opengeni credits back on to choose exact models instead.`
          : `${following ? organizationLabel : "This workspace"} allows ${visiblePolicyAllowedCount} of ${models.length} models by provider, and may also allow future models from the same providers. It was set through the API; the providers themselves aren't shown here.`}
      </Notice>
    ) : (
      <Notice tone="waiting" title="Refresh after the update finishes">
        This browser doesn't have the full model list yet. The provider limit stays as it is, and it
        can't be replaced until you refresh.
      </Notice>
    );
    body = followRow ? (
      <div className="flex min-w-0 flex-col gap-4">
        {followRow}
        {providerNotice}
      </div>
    ) : (
      providerNotice
    );
  } else if (draft) {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        {followRow}
        {creditsOff ? (
          <Notice tone="info" title="Opengeni credits are off">
            Models paid with credits can't run in this workspace, even if they're allowed here. Turn
            credits back on from Models.
          </Notice>
        ) : null}
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
                  following
                    ? `Follows ${organizationLabel}. Turn off “Use ${organizationLabel}’s allowed models” to change it.`
                    : disabled
                      ? organizationScope
                        ? "Only organization owners and admins can change this."
                        : "Only workspace admins can change Allowed models."
                      : undefined
                }
                onCheckedChange={(next) => setMode(next ? "unrestricted" : "selected")}
              />
            }
          />
        </SettingRowGroup>
        {nothingUsable ? (
          <Notice tone="waiting" title="No model can run here">
            {creditsOff
              ? "New chats and schedules won't start until you allow a model paid by a subscription or API key, connect one, or turn Opengeni credits back on."
              : organizationScope
                ? "Workspaces that follow this list can't start new chats or schedules until it allows at least one model."
                : "New chats and schedules won't start until you allow at least one model."}
          </Notice>
        ) : null}
        {draft.mode === "selected" ? (
          <ModelChecklist
            groups={groups}
            customIds={customIds}
            selected={draft.selectedModelIds}
            canManage={canManage && !following}
            creditsOff={creditsOff}
            onToggle={setModelSelected}
            onToggleMany={setModelsSelected}
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
        description={
          organizationScope
            ? `Choose which models people can pick in every workspace. A workspace can choose its own instead.`
            : "Choose which models people can pick for new chats and schedules."
        }
        onClose={onClose}
        loading={state.loading && !saved}
        submitLabel="Save"
        pendingLabel="Saving…"
        submitDisabled={
          !canManage || !dirty || (draft?.mode === "provider" && !(draft.follow !== saved?.follow))
        }
        // The footer shows only while there is something to save.
        className={canManage && dirty ? undefined : "[&>form>footer]:hidden"}
        footerStart={
          following
            ? `Follows ${organizationLabel}`
            : draft && draft.mode !== "provider"
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
/**
 * Models grouped by provider, one row each, with a checkbox on the right. Each
 * group heading names who pays and has its own checkbox to pick the whole
 * group at once. With Opengeni credits off, credit models are muted and can't
 * be changed (their saved choice is kept for when credits come back).
 */
function ModelChecklist({
  groups,
  customIds,
  selected,
  canManage,
  creditsOff,
  onToggle,
  onToggleMany,
  onAdd,
}: {
  groups: [string, WorkspaceModelCatalogModel[]][];
  customIds: string[];
  selected: Set<string>;
  canManage: boolean;
  creditsOff: boolean;
  onToggle: (modelId: string, selected: boolean) => void;
  onToggleMany: (modelIds: readonly string[], selected: boolean) => void;
  onAdd: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [customModelId, setCustomModelId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const total = groups.reduce((count, [, models]) => count + models.length, 0);
  const shown = filterModelGroups(groups, query);

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
      {total >= MODEL_LIST_SEARCH_AT ? (
        <ModelSearchField value={query} onChange={setQuery} />
      ) : null}
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Connect a subscription or API key to choose its models.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-fg-muted">No models match “{query.trim()}”.</p>
      ) : (
        shown.map(([providerLabel, providerModels]) => {
          const lockedByCredits = (model: WorkspaceModelCatalogModel) =>
            creditsOff && modelUsesCredits(model);
          const changeable = providerModels.filter((model) => !lockedByCredits(model));
          const changeableSelected = changeable.filter((model) => selected.has(model.id)).length;
          const payers = [...new Set(providerModels.map((model) => payerSummaryForModel(model)))];
          return (
            <ModelGroup
              key={providerLabel}
              label={providerLabel}
              meta={payers.length === 1 ? payers[0] : undefined}
              control={
                changeable.length > 1 ? (
                  <Checkbox
                    aria-label={`All ${providerLabel} models`}
                    checked={changeableSelected === changeable.length}
                    indeterminate={changeableSelected > 0 && changeableSelected < changeable.length}
                    disabled={!canManage}
                    onCheckedChange={(checked) =>
                      onToggleMany(
                        changeable.map((model) => model.id),
                        checked,
                      )
                    }
                  />
                ) : null
              }
            >
              {providerModels.map((model) => {
                const locked = lockedByCredits(model);
                const interactive = canManage && !locked;
                return (
                  <li key={model.id} className="min-w-0">
                    <label
                      title={model.id}
                      className={cn(
                        "-mx-3 flex min-h-11 min-w-0 items-center gap-3 rounded-[10px] px-3",
                        interactive
                          ? "cursor-pointer transition-colors duration-[120ms] hover:bg-surface-2"
                          : "opacity-80",
                      )}
                    >
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm",
                          locked ? "text-fg-muted" : "text-fg",
                        )}
                      >
                        {model.label}
                      </span>
                      {locked ? (
                        <span className="shrink-0 text-xs text-fg-muted">Credits off</span>
                      ) : null}
                      <Checkbox
                        aria-label={model.label}
                        checked={selected.has(model.id)}
                        disabled={!interactive}
                        onCheckedChange={(checked) => onToggle(model.id, checked)}
                      />
                    </label>
                  </li>
                );
              })}
            </ModelGroup>
          );
        })
      )}
      {customIds.length > 0 ? (
        <ModelGroup label="Added by ID">
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
        </ModelGroup>
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
