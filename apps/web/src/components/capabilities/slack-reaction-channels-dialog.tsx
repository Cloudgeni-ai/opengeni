import type { WorkspaceSlackReactionSummonSettings } from "@opengeni/contracts";
import type { SlackReactionChannel } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { openGeniSlackBotConnectionOptions } from "@/lib/slack-bot";
import type { ConnectionMetadata } from "@opengeni/react/app/types";

import { Button } from "@opengeni/react/ui/button";
import { CheckboxField } from "@opengeni/react/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opengeni/react/ui/dialog";
import { Select } from "@opengeni/react/ui/select";
import { useAppContext } from "@opengeni/react/app/app-context";

/**
 * Where the reaction shortcut works: anywhere the bot is a member, or only in
 * selected conversations. Opened from the Slack sheet's reaction option; the
 * on/off switch itself lives in the sheet.
 */
export function SlackReactionChannelsDialog({
  workspaceId,
  connectionId,
  connections,
  settings,
  open,
  canManage,
  onOpenChange,
  onSave,
}: {
  workspaceId: string;
  connectionId: string | null;
  /** The workspace policy spans all verified installations stored here. */
  connections?: ConnectionMetadata[];
  settings: WorkspaceSlackReactionSummonSettings;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (next: WorkspaceSlackReactionSummonSettings) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (connectionId || connections) ? (
        <SlackReactionChannelsDialogBody
          workspaceId={workspaceId}
          connectionId={connectionId}
          connections={connections}
          settings={settings}
          canManage={canManage}
          onClose={() => onOpenChange(false)}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function SlackReactionChannelsDialogBody({
  workspaceId,
  connectionId,
  connections,
  settings,
  canManage,
  onClose,
  onSave,
}: {
  workspaceId: string;
  connectionId: string | null;
  connections?: ConnectionMetadata[];
  settings: WorkspaceSlackReactionSummonSettings;
  canManage: boolean;
  onClose: () => void;
  onSave: (next: WorkspaceSlackReactionSummonSettings) => Promise<boolean>;
}) {
  const context = useAppContext();
  const [draft, setDraft] = useState<WorkspaceSlackReactionSummonSettings>(settings);
  const installations = useMemo(
    () =>
      connections === undefined
        ? connectionId
          ? [{ connectionId, label: "Slack workspace" }]
          : []
        : openGeniSlackBotConnectionOptions(
            [
              ...new Map(connections.map((connection) => [connection.id, connection])).values(),
            ].filter(
              (connection) =>
                connection.workspaceId === workspaceId && connection.status === "active",
            ),
          ).map(({ connection, label }) => ({ connectionId: connection.id, label })),
    [connections, connectionId, workspaceId],
  );
  const [channelGroups, setChannelGroups] = useState<
    Array<{ connectionId: string; label: string; channels: SlackReactionChannel[] }>
  >([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectedChannelIds =
    draft.channelPolicy.mode === "allowlist" ? draft.channelPolicy.channelIds : [];

  useEffect(() => {
    if (!canManage || draft.channelPolicy.mode !== "allowlist") return;
    let cancelled = false;
    setChannelGroups([]);
    setChannelsLoading(true);
    setChannelsError(null);
    void (async () => {
      try {
        const groups: typeof channelGroups = [];
        for (const installation of installations) {
          const collected: SlackReactionChannel[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 5; page += 1) {
            if (cancelled) return;
            const result = await context.client.listOpenGeniSlackReactionChannels(
              workspaceId,
              installation.connectionId,
              cursor,
            );
            collected.push(...result.channels);
            cursor = result.nextCursor ?? undefined;
            if (!cursor) break;
          }
          groups.push({
            ...installation,
            channels: [...new Map(collected.map((channel) => [channel.id, channel])).values()],
          });
        }
        if (!cancelled) setChannelGroups(groups);
      } catch (error) {
        if (!cancelled) setChannelsError(`Couldn't load Slack channels. ${userErrorText(error)}`);
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManage, installations, context.client, draft.channelPolicy.mode, workspaceId]);

  function toggleChannel(channelId: string, checked: boolean) {
    if (draft.channelPolicy.mode !== "allowlist") return;
    const selected = new Set(draft.channelPolicy.channelIds);
    if (checked && !selected.has(channelId) && selected.size >= 100) return;
    if (checked) selected.add(channelId);
    else selected.delete(channelId);
    setDraft({
      ...draft,
      channelPolicy: { mode: "allowlist", channelIds: [...selected] },
    });
  }

  async function save() {
    if (
      draft.enabled &&
      draft.channelPolicy.mode === "allowlist" &&
      draft.channelPolicy.channelIds.length === 0
    ) {
      toast.error("Select at least one conversation, or let it work anywhere Opengeni is a member");
      return;
    }
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Where the reaction shortcut works</DialogTitle>
        <DialogDescription>
          This setting applies to all Slack bots installed in this Opengeni workspace. React with
          the Opengeni emoji to start work from a message and its thread.
        </DialogDescription>
      </DialogHeader>

      <label className="grid gap-1 text-xs font-medium text-fg-muted">
        Where it works
        <Select
          value={draft.channelPolicy.mode}
          disabled={!canManage || saving}
          onChange={(event) =>
            setDraft({
              ...draft,
              channelPolicy:
                event.target.value === "allowlist"
                  ? { mode: "allowlist", channelIds: [] }
                  : { mode: "bot_member" },
            })
          }
        >
          <option value="bot_member">Anywhere Opengeni is a member</option>
          <option value="allowlist">Selected conversations</option>
        </Select>
      </label>

      {draft.channelPolicy.mode === "allowlist" ? (
        <div className="rounded-md border border-border bg-bg p-3">
          <p className="text-2xs font-medium text-fg-muted">Allowed conversations</p>
          {channelsLoading ? (
            <p className="mt-2 flex items-center gap-2 text-2xs text-fg-subtle">
              <Loader2Icon className="size-3 animate-spin" /> Loading conversations Opengeni has
              joined
            </p>
          ) : channelsError ? (
            <p className="mt-2 text-2xs text-danger">{channelsError}</p>
          ) : channelGroups.length === 0 ? (
            <p className="mt-2 text-2xs text-fg-subtle">
              No active Slack bot installations in this Opengeni workspace.
            </p>
          ) : (
            <div className="mt-2 max-h-72 space-y-4 overflow-y-auto">
              {channelGroups.map((group) => (
                <fieldset key={group.connectionId} className="space-y-2">
                  <legend className="text-xs font-medium text-fg">{group.label}</legend>
                  {group.channels.length === 0 ? (
                    <p className="text-xs text-fg-subtle">No joined conversations.</p>
                  ) : (
                    group.channels.map((channel) => (
                      <CheckboxField
                        key={channel.id}
                        label={`${channel.isPrivate ? "Private · " : "#"}${channel.name ?? channel.id}`}
                        checked={selectedChannelIds.includes(channel.id)}
                        disabled={
                          !canManage ||
                          saving ||
                          (selectedChannelIds.length >= 100 &&
                            !selectedChannelIds.includes(channel.id))
                        }
                        onCheckedChange={(checked) => toggleChannel(channel.id, checked)}
                      />
                    ))
                  )}
                </fieldset>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            !canManage ||
            saving ||
            (draft.channelPolicy.mode === "allowlist" &&
              (channelsLoading || channelsError !== null))
          }
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
