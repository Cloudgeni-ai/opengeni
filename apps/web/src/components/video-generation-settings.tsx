import type { VideoGenerationFundingSource, WorkspaceVideoGenerationSettings } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { RowSelect } from "@/components/settings/row-select";
import type { SelectOption } from "@/components/ui/select-menu";
import { SettingRow, SettingRowLink } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";

const SEEDANCE_2_5 = "bytedance/seedance-2.5";
const GROK_IMAGINE_VIDEO_1_5 = "xai/grok-imagine-video-1.5";

function modelForFunding(source: VideoGenerationFundingSource): string {
  return source === "supergrok_subscription" ? GROK_IMAGINE_VIDEO_1_5 : SEEDANCE_2_5;
}

export function VideoGenerationPreferenceRow({
  workspaceId,
  canManage,
  refreshKey,
  onConnectGateway,
}: {
  workspaceId: string;
  canManage: boolean;
  refreshKey: number;
  /** Opens the page that connects a workspace AI Gateway key. */
  onConnectGateway?: () => void;
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

  const enabled = settings?.policy.enabledModelIds.length === 1;
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
  const selectedModelId = modelForFunding(selectedFundingSource);
  const available =
    selectedFunding?.available === true &&
    settings?.availableModels.some((model) => model.modelId === selectedModelId) === true;

  async function updatePolicy(fundingSource: VideoGenerationFundingSource, nextEnabled: boolean) {
    if (!settings || !canManage || saving) return;
    setSaving(true);
    try {
      const policy = await client.updateVideoGenerationPolicy(workspaceId, {
        expectedRevision: settings.policy.revision,
        fundingSource,
        enabledModelIds: nextEnabled ? [modelForFunding(fundingSource)] : [],
        defaultModelId: nextEnabled ? modelForFunding(fundingSource) : null,
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
      toast.success(
        enabled
          ? "Video generation is off for new sessions"
          : "Video generation is on for new sessions",
      );
    } catch (error) {
      toast.error("Couldn't update video generation", { description: userErrorText(error) });
    }
  }

  async function changeFunding(fundingSource: VideoGenerationFundingSource) {
    if (!settings || fundingSource === settings.policy.fundingSource || saving) return;
    try {
      await updatePolicy(fundingSource, enabled);
      toast.success(
        fundingSource === "opengeni_credits"
          ? "Video generation will use Opengeni credits"
          : fundingSource === "supergrok_subscription"
            ? "Video generation will use SuperGrok"
            : "Video generation will use your Gateway",
      );
    } catch (error) {
      toast.error("Couldn't update video generation funding", {
        description: userErrorText(error),
      });
    }
  }

  const payerOptions: SelectOption<VideoGenerationFundingSource>[] = (
    settings?.fundingOptions ?? []
  ).map((option) => ({
    value: option.source,
    label: option.label,
    description: option.description,
    disabled: !option.available,
    ...(option.available
      ? {}
      : { disabledReason: option.unavailableReason ?? "Not available in this workspace." }),
  }));
  const noFunding =
    Boolean(settings) && !settings!.fundingOptions.some((option) => option.available);
  const reason = failed
    ? "Couldn't load video generation settings. Reload to try again."
    : !canManage
      ? "Only workspace admins can change this."
      : !enabled && settings && !available
        ? (selectedFunding?.unavailableReason ?? "Nothing is set up to pay for videos yet.")
        : undefined;

  return (
    <SettingRow
      label="Video generation"
      description={
        noFunding
          ? "Let agents make short videos. Needs an AI Gateway key or a plan to pay for them."
          : "Let agents make short videos. Paid by the account you choose."
      }
      hint={
        noFunding && canManage && onConnectGateway ? (
          <SettingRowLink onClick={onConnectGateway}>Connect AI Gateway</SettingRowLink>
        ) : undefined
      }
      control={
        <Switch
          checked={enabled}
          pending={saving || (!settings && !failed)}
          disabled={Boolean(reason)}
          disabledReason={reason}
          onCheckedChange={() => void toggle()}
        />
      }
    >
      {settings && enabled ? (
        <SettingRow
          label="Paid by"
          description="Every video shows who paid for it."
          controlWidth="select"
          control={
            <RowSelect
              options={payerOptions}
              value={selectedFundingSource}
              disabled={!canManage || saving}
              onValueChange={(next) => void changeFunding(next)}
            />
          }
        />
      ) : null}
    </SettingRow>
  );
}
