import {
  hasOpenGeniSlackReactionScope,
  resolveWorkspaceSlackReactionSummonSettings,
  type WorkspaceSlackReactionSummonSettings,
} from "@opengeni/contracts";
import type { SlackReactionChannel } from "@opengeni/sdk";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";
import type { ConnectionMetadata } from "@/types";

export function SlackReactionSummonCard({
  workspaceId,
  connection,
  canManage,
  installBusy,
  onReinstall,
}: {
  workspaceId: string;
  connection: ConnectionMetadata;
  canManage: boolean;
  installBusy: boolean;
  onReinstall: () => void;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const stored = useMemo(
    () => resolveWorkspaceSlackReactionSummonSettings(workspace?.settings),
    [workspace?.settings],
  );
  const [draft, setDraft] = useState<WorkspaceSlackReactionSummonSettings>(stored);
  const [channels, setChannels] = useState<SlackReactionChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scopeReady = hasOpenGeniSlackReactionScope(connection.grantedScopes);
  const installReady = connection.status === "active" && scopeReady;
  const selectedChannelIds =
    draft.channelPolicy.mode === "allowlist" ? draft.channelPolicy.channelIds : [];

  useEffect(() => setDraft(stored), [stored]);

  useEffect(() => {
    if (!canManage || !installReady || draft.channelPolicy.mode !== "allowlist") return;
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
            connection.id,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (!cancelled) {
          const deduplicated = [
            ...new Map(collected.map((channel) => [channel.id, channel])).values(),
          ];
          setChannels(deduplicated);
        }
      } catch (error) {
        if (!cancelled) {
          setChannelsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    canManage,
    connection.id,
    context.client,
    draft.channelPolicy.mode,
    installReady,
    workspaceId,
  ]);

  async function save() {
    if (draft.enabled && !installReady) {
      toast.error("Reinstall the Slack bot before enabling reaction summon");
      return;
    }
    if (
      draft.enabled &&
      draft.channelPolicy.mode === "allowlist" &&
      draft.channelPolicy.channelIds.length === 0
    ) {
      toast.error("Select at least one Slack conversation or use the bot-member policy");
      return;
    }
    setSaving(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        slackReactionSummon: draft,
      });
      if (updated) toast.success("Slack reaction summon settings saved");
    } finally {
      setSaving(false);
    }
  }

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

  return (
    <div className="mt-4 rounded-lg border border-border bg-bg/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-fg">Summon OpenGeni with an emoji</p>
          <p className="mt-1 max-w-2xl text-2xs leading-5 text-fg-muted">
            Disabled by default. A linked, authorized user can react to one message; OpenGeni reads
            only that message and bounded containing-thread context, then replies in the same
            thread. This does not authorize channel ingestion or automatic Knowledge, Memory,
            preference, or policy writes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-fg">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!canManage || !installReady || saving}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>

      {!scopeReady ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-2xs leading-5 text-fg-muted">
              <strong className="text-fg">Reinstall required.</strong> This installation is missing
              the least-privilege <code>reactions:read</code> scope. Existing Slack tools remain
              available, but reaction summon stays disabled until an admin reinstalls the bot.
            </p>
          </div>
          {canManage ? (
            <Button type="button" size="sm" disabled={installBusy} onClick={onReinstall}>
              {installBusy ? <Loader2Icon className="animate-spin" /> : null}
              Reinstall Slack bot
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-2xs font-medium text-fg-muted">
          Emoji name
          <Input
            className="mt-1"
            value={draft.emoji}
            disabled={!canManage || saving}
            maxLength={64}
            placeholder="genie"
            onChange={(event) => setDraft({ ...draft, emoji: event.target.value.trim() })}
          />
          <span className="mt-1 block font-normal text-fg-subtle">
            Exact Slack emoji name without surrounding colons, for example <code>genie</code>.
          </span>
        </label>

        <label className="text-2xs font-medium text-fg-muted">
          Conversation policy
          <select
            className="mt-1 h-9 w-full rounded-md border border-border bg-bg px-3 text-xs text-fg"
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
            <option value="bot_member">Every conversation where the bot is already a member</option>
            <option value="allowlist">Only selected conversations</option>
          </select>
          <span className="mt-1 block font-normal text-fg-subtle">
            OpenGeni never auto-joins a channel and shared Slack Connect conversations fail closed.
          </span>
        </label>
      </div>

      {draft.channelPolicy.mode === "allowlist" ? (
        <div className="mt-3 rounded-md border border-border bg-bg p-3">
          <p className="text-2xs font-medium text-fg-muted">Allowed conversations</p>
          {channelsLoading ? (
            <p className="mt-2 flex items-center gap-2 text-2xs text-fg-subtle">
              <Loader2Icon className="size-3 animate-spin" /> Loading bot-member conversations…
            </p>
          ) : channelsError ? (
            <p className="mt-2 text-2xs text-danger">{channelsError}</p>
          ) : channels.length === 0 ? (
            <p className="mt-2 text-2xs text-fg-subtle">
              No eligible bot-member conversations are available. Invite OpenGeni in Slack, then
              return here.
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

      {canManage ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin" /> : null}
            Save reaction settings
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-2xs text-fg-subtle">
          Workspace administrator permission is required to change this setting.
        </p>
      )}
    </div>
  );
}
