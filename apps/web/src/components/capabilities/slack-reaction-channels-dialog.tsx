import type { WorkspaceSlackReactionSummonSettings } from "@opengeni/contracts";
import type { SlackReactionChannel } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";

/**
 * Where the reaction shortcut works: anywhere the bot is a member, or only in
 * selected conversations. Opened from the Slack sheet's reaction option; the
 * on/off switch itself lives in the sheet.
 */
export function SlackReactionChannelsDialog({
  workspaceId,
  connectionId,
  settings,
  open,
  canManage,
  onOpenChange,
  onSave,
}: {
  workspaceId: string;
  connectionId: string | null;
  settings: WorkspaceSlackReactionSummonSettings;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (next: WorkspaceSlackReactionSummonSettings) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && connectionId ? (
        <SlackReactionChannelsDialogBody
          workspaceId={workspaceId}
          connectionId={connectionId}
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
  settings,
  canManage,
  onClose,
  onSave,
}: {
  workspaceId: string;
  connectionId: string;
  settings: WorkspaceSlackReactionSummonSettings;
  canManage: boolean;
  onClose: () => void;
  onSave: (next: WorkspaceSlackReactionSummonSettings) => Promise<boolean>;
}) {
  const context = useAppContext();
  const [draft, setDraft] = useState<WorkspaceSlackReactionSummonSettings>(settings);
  const [channels, setChannels] = useState<SlackReactionChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectedChannelIds =
    draft.channelPolicy.mode === "allowlist" ? draft.channelPolicy.channelIds : [];

  useEffect(() => {
    if (!canManage || draft.channelPolicy.mode !== "allowlist") return;
    let cancelled = false;
    setChannelsLoading(true);
    setChannelsError(null);
    void (async () => {
      try {
        const collected: SlackReactionChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await context.client.listOpenGeniSlackReactionChannels(
            workspaceId,
            connectionId,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (!cancelled) {
          setChannels([...new Map(collected.map((channel) => [channel.id, channel])).values()]);
        }
      } catch (error) {
        if (!cancelled) setChannelsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManage, connectionId, context.client, draft.channelPolicy.mode, workspaceId]);

  function toggleChannel(channelId: string, checked: boolean) {
    if (draft.channelPolicy.mode !== "allowlist") return;
    const selected = new Set(draft.channelPolicy.channelIds);
    if (checked) selected.add(channelId);
    else selected.delete(channelId);
    setDraft({
      ...draft,
      channelPolicy: { mode: "allowlist", channelIds: [...selected].slice(0, 100) },
    });
  }

  async function save() {
    if (
      draft.enabled &&
      draft.channelPolicy.mode === "allowlist" &&
      draft.channelPolicy.channelIds.length === 0
    ) {
      toast.error("Select at least one conversation, or let it work anywhere OpenGeni is a member");
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
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Where the reaction shortcut works</DialogTitle>
        <DialogDescription>
          React with the OpenGeni emoji on a message to start work from it. This reads the selected
          message and its thread; it does not sync the channel.
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
          <option value="bot_member">Anywhere OpenGeni is a member</option>
          <option value="allowlist">Selected conversations</option>
        </Select>
      </label>

      {draft.channelPolicy.mode === "allowlist" ? (
        <div className="rounded-md border border-border bg-bg p-3">
          <p className="text-2xs font-medium text-fg-muted">Allowed conversations</p>
          {channelsLoading ? (
            <p className="mt-2 flex items-center gap-2 text-2xs text-fg-subtle">
              <Loader2Icon className="size-3 animate-spin" /> Loading conversations OpenGeni has
              joined
            </p>
          ) : channelsError ? (
            <p className="mt-2 text-2xs text-danger">{channelsError}</p>
          ) : channels.length === 0 ? (
            <p className="mt-2 text-2xs text-fg-subtle">
              OpenGeni has not been invited anywhere yet. Tag @OpenGeni in Slack, then return here.
            </p>
          ) : (
            <div className="mt-2 grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
              {channels.map((channel) => (
                <label key={channel.id} className="flex items-center gap-2 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={selectedChannelIds.includes(channel.id)}
                    disabled={!canManage || saving}
                    onChange={(event) => toggleChannel(channel.id, event.target.checked)}
                  />
                  <span className="truncate">
                    {channel.isPrivate ? "Private · " : "#"}
                    {channel.name ?? channel.id}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={!canManage || saving} onClick={() => void save()}>
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
