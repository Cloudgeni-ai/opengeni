import type { WorkspaceVideoGenerationSettings } from "@opengeni/sdk";
import { VideoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PreferenceToggleRow } from "@/components/transcription-settings";
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
  const available =
    settings?.providerConfigured === true &&
    settings.availableModels.some((model) => model.modelId === SEEDANCE_2_5);

  async function toggle() {
    if (!settings || !available || !canManage || saving) return;
    setSaving(true);
    try {
      const policy = await client.updateVideoGenerationPolicy(workspaceId, {
        expectedRevision: settings.policy.revision,
        enabledModelIds: enabled ? [] : [SEEDANCE_2_5],
        defaultModelId: enabled ? null : SEEDANCE_2_5,
      });
      setSettings((current) => (current ? { ...current, policy } : current));
      toast.success(enabled ? "Video generation disabled" : "Video generation enabled");
    } catch (error) {
      toast.error("Couldn't update video generation", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
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
            : available
              ? "Allow agents to generate videos with Seedance 2.5 through your AI Gateway."
              : "Connect a workspace Vercel AI Gateway key first."
      }
      checked={enabled}
      disabled={!canManage || !settings || !available || saving}
      saving={saving}
      onToggle={() => void toggle()}
    />
  );
}
