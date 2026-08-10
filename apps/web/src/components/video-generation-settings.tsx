import type { VideoGenerationFundingSource, WorkspaceVideoGenerationSettings } from "@opengeni/sdk";
import { VideoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PreferenceToggleRow } from "@/components/transcription-settings";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";

const SEEDANCE_2_5 = "bytedance/seedance-2.5";

export function VideoGenerationPreferenceRow({
  workspaceId,
  canManage,
  refreshKey,
}: {
  workspaceId: string;
  canManage: boolean;
  refreshKey: number;
}) {
  const client = useAppContext().client;
  const [settings, setSettings] = useState<WorkspaceVideoGenerationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSettings(null);
    setFailed(false);
    void client
      .getVideoGenerationSettings(workspaceId, { signal: controller.signal })
      .then(setSettings, () => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [client, refreshKey, workspaceId]);

  const enabled = settings?.policy.enabledModelIds.includes(SEEDANCE_2_5) === true;
  const selectedFundingSource =
    settings?.fundingOptions.find(
      (option) => option.source === settings.policy.fundingSource && option.available,
    )?.source ??
    settings?.fundingOptions.find((option) => option.available)?.source ??
    settings?.policy.fundingSource ??
    "workspace_gateway";
  const selectedFunding = settings?.fundingOptions.find(
    (option) => option.source === selectedFundingSource,
  );
  const available =
    selectedFunding?.available === true &&
    settings?.availableModels.some((model) => model.modelId === SEEDANCE_2_5) === true;

  async function updatePolicy(fundingSource: VideoGenerationFundingSource, nextEnabled: boolean) {
    if (!settings || !canManage || saving) return;
    setSaving(true);
    try {
      const policy = await client.updateVideoGenerationPolicy(workspaceId, {
        expectedRevision: settings.policy.revision,
        fundingSource,
        enabledModelIds: nextEnabled ? [SEEDANCE_2_5] : [],
        defaultModelId: nextEnabled ? SEEDANCE_2_5 : null,
      });
      setSettings((current) => (current ? { ...current, policy } : current));
      return policy;
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    if (!settings || !canManage || saving || (!enabled && !available)) return;
    try {
      await updatePolicy(selectedFundingSource, !enabled);
      toast.success(enabled ? "Video generation disabled" : "Video generation enabled");
    } catch (error) {
      toast.error("Couldn't update video generation", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function changeFunding(fundingSource: VideoGenerationFundingSource) {
    if (!settings || fundingSource === settings.policy.fundingSource || saving) return;
    try {
      await updatePolicy(fundingSource, enabled);
      toast.success(
        fundingSource === "opengeni_credits"
          ? "Video generation will use OpenGeni credits"
          : "Video generation will use your Gateway",
      );
    } catch (error) {
      toast.error("Couldn't update video generation funding", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <PreferenceToggleRow
      icon={<VideoIcon className="size-3.5 text-brand" />}
      label="Video generation"
      description={
        failed
          ? "Video generation settings are unavailable."
          : !settings
            ? "Loading Seedance 2.5 availability…"
            : selectedFunding?.available
              ? selectedFunding.description
              : (selectedFunding?.unavailableReason ?? "No video funding route is configured.")
      }
      checked={enabled}
      disabled={!canManage || !settings || (!enabled && !available) || saving}
      saving={saving}
      control={
        settings ? (
          <Select
            aria-label="Video generation funding"
            value={selectedFundingSource}
            disabled={
              !canManage || saving || !settings.fundingOptions.some((option) => option.available)
            }
            onChange={(event) =>
              void changeFunding(event.currentTarget.value as VideoGenerationFundingSource)
            }
            className="h-7 w-32 py-0 text-xs"
          >
            {settings.fundingOptions.map((option) => (
              <option key={option.source} value={option.source} disabled={!option.available}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : null
      }
      onToggle={() => void toggle()}
    />
  );
}
