import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import type { DefaultModelSelectionSource, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { payerShortLabel } from "@/components/models/models-ui";
import { ModelPicker } from "@/components/pickers";
import { buttonVariants } from "@/components/ui/button";
import { SettingRow } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import {
  availabilityReasonLabel,
  billingClassForModel,
  billingClassLabel,
  payerSummaryForModel,
  type PickerModelRow,
} from "@/lib/model-policy";
import { initialReasoningEffort } from "@/lib/session-tools";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { cn } from "@/lib/utils";
import type { IntelligenceEffort } from "@/lib/session-tools";

type Draft = { model: string; reasoningEffort: IntelligenceEffort };

/** How an unsaved workspace default is chosen, in plain words. */
function automaticDefaultNote(source: DefaultModelSelectionSource | undefined): string {
  switch (source) {
    case "subscription":
      return "Picked from your connected subscription until you choose one.";
    case "credits":
      return "Picked for your Opengeni credits until you choose one.";
    default:
      return "The deployment's default until you choose one.";
  }
}

/**
 * Picker rows for the default-model row. The shared picker only lists models
 * whose credentials are ready, but the current default may be one that can't
 * run yet (e.g. OpenGeni credits without a balance). Keep that real catalog
 * entry visible as an unselectable row so the trigger shows its label and
 * payment source instead of a raw id.
 */
export function defaultModelPickerRows(
  rows: PickerModelRow[],
  models: WorkspaceModelCatalogModel[],
  modelId: string,
): PickerModelRow[] {
  if (rows.some((row) => row.id === modelId)) return rows;
  const catalog = models.find((model) => model.id === modelId);
  if (!catalog) return rows;
  const billingClass = billingClassForModel(catalog);
  return [
    ...rows,
    {
      id: catalog.id,
      label: catalog.label,
      ...(catalog.shortLabel ? { shortLabel: catalog.shortLabel } : {}),
      billingClass,
      billingClassLabel: billingClassLabel(billingClass),
      selectable: false,
      unavailableReason: availabilityReasonLabel(catalog.availability.reason) ?? "Unavailable",
      provider: catalog.provider,
      providerLabel: catalog.providerLabel,
      catalog,
    },
  ];
}

/** One line naming the default, who pays for it, and whether it can run now. */
export function defaultModelSummary(
  models: WorkspaceModelCatalogModel[],
  modelId: string,
): { text: string; unavailable: string | null } | null {
  const catalog = models.find((model) => model.id === modelId);
  if (!catalog) return null;
  const runnable =
    catalog.credentialReadiness.status === "ready" && catalog.availability.selectable;
  return {
    text: `${catalog.label} · ${payerSummaryForModel(catalog)}`,
    unavailable: runnable
      ? null
      : `Can't run right now: ${
          availabilityReasonLabel(catalog.availability.reason) ?? "Unavailable"
        }`,
  };
}

/** Workspace default inherited by new chats and new scheduled tasks. */
export function DefaultSessionModelPreferenceRow(props: {
  workspaceId: string;
  canManage: boolean;
  /**
   * Who pays for the default, in words: "paid with Acme's Opengeni credits".
   * The trigger already names the model and its payment source; this says whose.
   */
  describePayer?: ((model: WorkspaceModelCatalogModel) => string) | undefined;
}) {
  const context = useAppContext();
  const catalog = useWorkspaceModelCatalog(props.workspaceId);
  const workspace = context.workspaces.find((candidate) => candidate.id === props.workspaceId);
  const configured = resolveWorkspaceSessionDefaults(workspace?.settings);
  // Without a saved default, show what new chats actually get: the server
  // resolves a connected subscription, then credits, then the deployment model.
  const automatic = catalog.defaultSelection;
  const effective: Draft = {
    model: configured?.model ?? automatic?.model ?? context.clientConfig.defaultModel,
    reasoningEffort:
      configured?.reasoningEffort ??
      automatic?.reasoningEffort ??
      initialReasoningEffort(context.clientConfig),
  };
  const [draft, setDraft] = useState<Draft>(effective);
  const draftRef = useRef(draft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = {
      model: configured?.model ?? automatic?.model ?? context.clientConfig.defaultModel,
      reasoningEffort:
        configured?.reasoningEffort ??
        automatic?.reasoningEffort ??
        initialReasoningEffort(context.clientConfig),
    };
    draftRef.current = next;
    setDraft(next);
  }, [
    automatic?.model,
    automatic?.reasoningEffort,
    configured?.model,
    configured?.reasoningEffort,
    context.clientConfig,
  ]);

  const pickerRows = defaultModelPickerRows(catalog.rows, catalog.models, draft.model);

  function updateDraft(next: Draft) {
    draftRef.current = next;
    setDraft(next);
  }

  async function save(reasoningEffort: IntelligenceEffort) {
    const next = { ...draftRef.current, reasoningEffort };
    updateDraft(next);
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(props.workspaceId, {
        sessionDefaults: next,
      });
      if (updated) {
        toast.success("Default model updated");
      } else {
        updateDraft(effective);
      }
    } finally {
      setSaving(false);
    }
  }

  const selected = pickerRows.find((row) => row.id === draft.model) ?? null;
  const selectedModel = catalog.models.find((model) => model.id === draft.model) ?? null;
  const payer = selectedModel && props.describePayer ? props.describePayer(selectedModel) : null;
  const starts = payer
    ? `New chats and schedules start with this model, ${payer}.`
    : "New chats and schedules start with this model.";
  const cantRun =
    catalog.loading || catalog.error
      ? null
      : !selected
        ? "The current default isn't available in this workspace, so new work can't start with it. Pick another model."
        : !selected.selectable
          ? `${selected.label} can't run right now${
              selected.unavailableReason
                ? `: ${selected.unavailableReason.toLocaleLowerCase()}`
                : ""
            }. Pick another model.`
          : null;

  return (
    <SettingRow
      label="Default model"
      controlWidth="auto"
      description={configured ? starts : `${starts} ${automaticDefaultNote(automatic?.source)}`}
      error={cantRun}
      hint={saving ? "Saving…" : undefined}
      control={
        <ModelPicker
          rows={pickerRows}
          model={draft.model}
          effort={draft.reasoningEffort}
          latencyMode="standard"
          allowLatencyMode={false}
          disabled={!props.canManage || saving}
          loading={catalog.loading}
          error={catalog.error}
          messages={{ label: "Default model and reasoning" }}
          // Models settings keeps its scope-aware presentation.
          collapseScopes={false}
          triggerStyle="field"
          triggerMeta={selected ? payerShortLabel(selected) : null}
          // The secondary button's exact look, so every control on the row matches.
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "max-w-full min-w-[180px] justify-start gap-2 rounded-[10px] px-2.5 pointer-coarse:h-11",
          )}
          onModelChange={(model) => updateDraft({ ...draftRef.current, model })}
          onEffortChange={(effort) => void save(effort)}
          onLatencyModeChange={() => {}}
        />
      }
    />
  );
}
