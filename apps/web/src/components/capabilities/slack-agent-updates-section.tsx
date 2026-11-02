import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SlackAgentUpdateSettings } from "@opengeni/sdk";
import { useAppContext } from "@opengeni/react/app/app-context";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { Notice } from "@opengeni/react/ui/notice";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import type { ConnectionMetadata } from "@opengeni/react/app/types";

const ADMIN_ONLY = "Only an organization admin can change this.";

/**
 * Update messages about Slack agents for one Slack installation: an
 * organization admin turns direct messages about new agents on or off, limits
 * announcements to channel intro posts, or sends themselves a preview.
 */
export function SlackAgentUpdatesSection({ connection }: { connection: ConnectionMetadata }) {
  const { client } = useAppContext();
  const [settings, setSettings] = useState<SlackAgentUpdateSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"updatesEnabled" | "channelPostsOnly" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setSettings(null);
    setError(null);
    void client
      .getOpenGeniSlackAgentUpdateSettings(connection.workspaceId, connection.id)
      .then((result) => {
        if (live) setSettings(result);
      })
      .catch((failure) => {
        if (live) setError(userErrorText(failure));
      });
    return () => {
      live = false;
    };
  }, [client, connection.workspaceId, connection.id, revision]);

  async function save(field: "updatesEnabled" | "channelPostsOnly", value: boolean) {
    if (!settings) return;
    setSaving(field);
    try {
      setSettings(
        await client.setOpenGeniSlackAgentUpdateSettings(connection.workspaceId, {
          connectionId: connection.id,
          updatesEnabled: settings.updatesEnabled,
          channelPostsOnly: settings.channelPostsOnly,
          [field]: value,
        }),
      );
    } catch (failure) {
      toast.error("Couldn't save", { description: userErrorText(failure) });
    } finally {
      setSaving(null);
    }
  }

  async function preview() {
    setPreviewing(true);
    try {
      await client.previewOpenGeniSlackAgentUpdate(connection.workspaceId, {
        connectionId: connection.id,
      });
      toast.success("Preview sent to your Slack messages");
    } catch (failure) {
      toast.error("Couldn't send the preview", { description: userErrorText(failure) });
    } finally {
      setPreviewing(false);
    }
  }

  const canManage = settings?.viewerCanManage === true;
  return (
    <DetailSection
      title="Update messages"
      action={
        canManage ? (
          <Button variant="outline" size="sm" disabled={previewing} onClick={() => void preview()}>
            Send me a preview
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <Notice
          tone="failed"
          action={
            <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : !settings ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <SettingRowGroup>
          <SettingRow
            label="Tell people about new agents"
            description="A short direct message when there's an agent they can use. At most once a month, at 10:00 on a weekday."
            control={
              <Switch
                aria-label="Tell people about new agents"
                checked={settings.updatesEnabled && !settings.channelPostsOnly}
                pending={saving === "updatesEnabled"}
                disabled={!canManage || settings.channelPostsOnly}
                disabledReason={!canManage ? ADMIN_ONLY : "Channel posts only is on."}
                onCheckedChange={(checked) => void save("updatesEnabled", checked)}
              />
            }
          />
          <SettingRow
            label="Channel posts only"
            description="Announce agents only with channel intro posts, never in direct messages."
            control={
              <Switch
                aria-label="Channel posts only"
                checked={settings.channelPostsOnly}
                pending={saving === "channelPostsOnly"}
                disabled={!canManage}
                disabledReason={ADMIN_ONLY}
                onCheckedChange={(checked) => void save("channelPostsOnly", checked)}
              />
            }
          />
        </SettingRowGroup>
      )}
    </DetailSection>
  );
}
