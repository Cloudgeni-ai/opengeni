import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import type { DefaultModelSelectionSource } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelPicker } from "@/components/pickers";
import { useAppContext } from "@/context";
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

  return (
    <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">Default model</p>
        <p className="mt-0.5 text-xs text-fg-subtle">
          Used for new chats and scheduled tasks in this workspace.
          {configured ? null : ` ${automaticDefaultNote(automatic?.source)}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saving ? (
          <Loader2Icon aria-label="Saving default model" className="size-3.5 animate-spin" />
        ) : null}
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
          onModelChange={(model) => updateDraft({ ...draftRef.current, model })}
          onEffortChange={(effort) => void save(effort)}
          onLatencyModeChange={() => {}}
        />
      </div>
    </div>
  );
}
