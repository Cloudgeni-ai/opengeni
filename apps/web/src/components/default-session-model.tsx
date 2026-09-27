import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import type { DefaultModelSelectionSource, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelPicker } from "@/components/pickers";
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
import type { IntelligenceEffort } from "@/lib/session-tools";

type Draft = { model: string; reasoningEffort: IntelligenceEffort };

/** How an unsaved workspace default is chosen, in plain words. */
function automaticDefaultNote(source: DefaultModelSelectionSource | undefined): string {
  switch (source) {
    case "subscription":
      return "Following your connected subscription until you choose one.";
    case "credits":
      return "Following your OpenGeni credits until you choose one.";
    default:
      return "Following the deployment default until you choose one or connect a subscription.";
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
  const summary = catalog.loading ? null : defaultModelSummary(catalog.models, draft.model);

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

  return (
    <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">Default model</p>
        <p className="mt-0.5 text-xs text-fg-subtle">
          Used for new chats and scheduled tasks in this workspace.
          {configured ? null : ` ${automaticDefaultNote(automatic?.source)}`}
        </p>
        {summary ? (
          <p className="mt-0.5 text-xs text-fg-muted">
            {summary.text}
            {summary.unavailable ? (
              <span className="text-status-waiting"> · {summary.unavailable}</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saving ? (
          <Loader2Icon aria-label="Saving default model" className="size-3.5 animate-spin" />
        ) : null}
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
          onModelChange={(model) => updateDraft({ ...draftRef.current, model })}
          onEffortChange={(effort) => void save(effort)}
          onLatencyModeChange={() => {}}
        />
      </div>
    </div>
  );
}
