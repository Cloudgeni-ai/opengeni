import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import type { DefaultModelSelectionSource } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { payerLabel } from "@/components/models/models-ui";
import { ModelPicker } from "@/components/pickers";
import { SettingRow } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { initialReasoningEffort } from "@/lib/session-tools";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import type { IntelligenceEffort } from "@/lib/session-tools";

type Draft = { model: string; reasoningEffort: IntelligenceEffort };

/** How an unsaved workspace default is chosen, in plain words. */
function automaticDefaultNote(source: DefaultModelSelectionSource | undefined): string {
  switch (source) {
    case "subscription":
      return "Picked from your connected subscription until you choose one.";
    case "credits":
      return "Picked for your OpenGeni credits until you choose one.";
    default:
      return "The deployment's default until you choose one.";
  }
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

  const selected = catalog.rows.find((row) => row.id === draft.model) ?? null;
  const named = selected
    ? `${selected.label} · ${payerLabel(selected.billingClass, selected.billingClassLabel)}`
    : null;
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
      controlWidth="select"
      description={
        <>
          {named ? <span className="text-fg">{named}. </span> : null}
          New chats and schedules start with this model unless someone picks another.
          {configured ? null : ` ${automaticDefaultNote(automatic?.source)}`}
        </>
      }
      error={cantRun}
      hint={saving ? "Saving…" : undefined}
      control={
        <ModelPicker
          rows={catalog.rows}
          model={draft.model}
          effort={draft.reasoningEffort}
          latencyMode="standard"
          allowLatencyMode={false}
          disabled={!props.canManage || saving}
          loading={catalog.loading}
          error={catalog.error}
          messages={{ label: "Default model and reasoning" }}
          className="border-border bg-surface text-fg hover:bg-surface-2"
          onModelChange={(model) => updateDraft({ ...draftRef.current, model })}
          onEffortChange={(effort) => void save(effort)}
          onLatencyModeChange={() => {}}
        />
      }
    />
  );
}
