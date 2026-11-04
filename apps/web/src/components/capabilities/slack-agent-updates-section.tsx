import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SlackAgentUpdateSettings, SlackReactionChannel } from "@opengeni/sdk";
import { useAppContext } from "@opengeni/react/app/app-context";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { Notice } from "@opengeni/react/ui/notice";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import type { ConnectionMetadata } from "@opengeni/react/app/types";

const ADMIN_ONLY = "Only an organization admin can change this.";
const NO_CHANNEL = "none";

function channelOptionLabel(channel: SlackReactionChannel): string {
  return channel.isPrivate ? (channel.name ?? channel.id) : `#${channel.name ?? channel.id}`;
}

/** Channels the Opengeni app is in, by name. */
function useAnnouncementChannels(connection: ConnectionMetadata, enabled: boolean) {
  const { client } = useAppContext();
  const [channels, setChannels] = useState<SlackReactionChannel[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      const collected: SlackReactionChannel[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 5; page += 1) {
          const result = await client.listOpenGeniSlackReactionChannels(
            connection.workspaceId,
            connection.id,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
      } catch {
        // Whatever loaded is still pickable; the saved channel always shows.
      }
      if (live) {
        setChannels(
          [...new Map(collected.map((row) => [row.id, row])).values()].sort((a, b) =>
            (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: "base" }),
          ),
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [client, connection.workspaceId, connection.id, enabled]);
  return channels;
}

/**
 * Update messages about Slack agents for one Slack installation: an
 * organization admin turns direct messages about new agents on or off, limits
 * announcements to channel intro posts, or sends themselves a preview.
 */
export function SlackAgentUpdatesSection({ connection }: { connection: ConnectionMetadata }) {
  const { client } = useAppContext();
  const [settings, setSettings] = useState<SlackAgentUpdateSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<
    "updatesEnabled" | "channelPostsOnly" | "announcementChannelId" | null
  >(null);
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

  async function save(
    change:
      | { updatesEnabled: boolean }
      | { channelPostsOnly: boolean }
      | { announcementChannelId: string | null },
  ) {
    if (!settings) return;
    setSaving(Object.keys(change)[0] as keyof typeof change);
    try {
      setSettings(
        await client.setOpenGeniSlackAgentUpdateSettings(connection.workspaceId, {
          connectionId: connection.id,
          updatesEnabled: settings.updatesEnabled,
          channelPostsOnly: settings.channelPostsOnly,
          ...change,
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
  const channels = useAnnouncementChannels(connection, canManage);
  const announcement = settings?.announcementChannelId ?? null;
  const channelOptions = [
    { value: NO_CHANNEL, label: "No channel" },
    ...(announcement && !channels?.some((channel) => channel.id === announcement)
      ? [{ value: announcement, label: announcement }]
      : []),
    ...(channels ?? []).map((channel) => ({
      value: channel.id,
      label: channelOptionLabel(channel),
      ...(channel.isPrivate ? { meta: "Private" } : {}),
    })),
  ];
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
                onCheckedChange={(checked) => void save({ updatesEnabled: checked })}
              />
            }
          />
          <SettingRow
            label="Announce new agents in"
            description="New agents' intros are posted here by default."
            control={
              <SelectMenu
                variant="combobox"
                size="sm"
                className="w-56"
                aria-label="Announce new agents in"
                searchPlaceholder="Search channels"
                value={announcement ?? NO_CHANNEL}
                options={channelOptions}
                loading={(canManage && channels === null) || saving === "announcementChannelId"}
                disabled={!canManage}
                disabledReason={!canManage ? ADMIN_ONLY : undefined}
                onValueChange={(value) =>
                  void save({ announcementChannelId: value === NO_CHANNEL ? null : value })
                }
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
                onCheckedChange={(checked) => void save({ channelPostsOnly: checked })}
              />
            }
          />
        </SettingRowGroup>
      )}
    </DetailSection>
  );
}
