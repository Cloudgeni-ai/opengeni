import { useEffect, useMemo, useState } from "react";

import { FormDisclosure } from "@/components/ui/form-disclosure";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  activeOpenGeniSlackBotConnections,
  openGeniSlackBotConnectionOptions,
} from "@/lib/slack-bot";
import type { ConnectionMetadata } from "@/types";

type SlackChannelOption = { id: string; name: string | null; isPrivate: boolean };

const MAX_CHANNEL_PAGES = 5;

export function scheduleSlackChannelLabel(
  channelId: string,
  channels: readonly SlackChannelOption[],
): string {
  const channel = channels.find((candidate) => candidate.id === channelId);
  return channel?.name ? `#${channel.name}` : "the chosen channel";
}

/**
 * The one Slack channel a scheduled task's runs may post to as the OpenGeni
 * workspace bot. A person chooses it here; the agent cannot post anywhere
 * else. Changing it needs permission to manage connections.
 */
export function ScheduleSlackPosting(props: {
  workspaceId: string;
  connectionId: string;
  channelId: string;
  disabled: boolean;
  onChange: (next: { connectionId: string; channelId: string }) => void;
}) {
  const context = useAppContext();
  const canRead =
    context.accessContext === null ||
    hasWorkspacePermission(context.accessContext, props.workspaceId, "connections:read");
  const canChoose =
    canRead &&
    (context.accessContext === null ||
      hasWorkspacePermission(context.accessContext, props.workspaceId, "connections:write"));
  const [open, setOpen] = useState(false);
  const [bots, setBots] = useState<ConnectionMetadata[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [channels, setChannels] = useState<SlackChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let current = true;
    void context.client
      .listConnections(props.workspaceId)
      .then((connections) => {
        if (current) setBots(activeOpenGeniSlackBotConnections(connections));
      })
      .catch((error: unknown) => {
        if (current) setBotsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [canRead, context.client, props.workspaceId]);

  const botOptions = useMemo(() => openGeniSlackBotConnectionOptions(bots ?? []), [bots]);
  const effectiveConnectionId =
    props.connectionId || (botOptions.length === 1 ? botOptions[0]!.connection.id : "");

  useEffect(() => {
    if (!canChoose || (!open && !props.channelId) || !effectiveConnectionId) {
      setChannels([]);
      return;
    }
    let current = true;
    setChannelsLoading(true);
    setChannelsError(null);
    void (async () => {
      const collected: SlackChannelOption[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
        const response = await context.client.listScheduledTaskSlackChannels(
          props.workspaceId,
          effectiveConnectionId,
          cursor,
        );
        collected.push(...response.channels);
        cursor = response.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return [...new Map(collected.map((channel) => [channel.id, channel])).values()];
    })()
      .then((loaded) => {
        if (current) setChannels(loaded);
      })
      .catch((error: unknown) => {
        if (current) {
          setChannels([]);
          setChannelsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (current) setChannelsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [canChoose, context.client, effectiveConnectionId, open, props.channelId, props.workspaceId]);

  const summary = props.channelId
    ? `Posts to ${scheduleSlackChannelLabel(props.channelId, channels)} as the OpenGeni bot`
    : "Off";
  const storedChannelMissing =
    Boolean(props.channelId) &&
    !channelsLoading &&
    !channels.some((channel) => channel.id === props.channelId);
  const storedBotMissing =
    Boolean(props.connectionId) &&
    bots !== null &&
    !botOptions.some((option) => option.connection.id === props.connectionId);

  return (
    <FormDisclosure title="Post to Slack" summary={summary} open={open} onOpenChange={setOpen}>
      <p className="text-xs text-fg-subtle">
        Each run can post to one Slack channel as the OpenGeni bot. The agent cannot post to any
        other channel. Invite the bot to a channel in Slack to see it here.
      </p>
      {!canChoose ? (
        <p className="text-xs text-fg-subtle">
          Only people who can manage connections can choose this channel.
        </p>
      ) : botsError ? (
        <p role="alert" className="text-xs text-status-failed">
          Slack connections could not be loaded. {botsError}
        </p>
      ) : bots !== null && botOptions.length === 0 && !props.connectionId ? (
        <p className="text-xs text-fg-subtle">
          No OpenGeni Slack bot is installed in this workspace. A task can post only through a bot
          installed in its own workspace, from Plugins.
        </p>
      ) : (
        <>
          {botOptions.length > 1 || storedBotMissing ? (
            <div className="grid gap-1.5">
              <Label>Slack workspace</Label>
              <Select
                value={props.connectionId}
                disabled={props.disabled}
                onChange={(event) =>
                  props.onChange({ connectionId: event.target.value, channelId: "" })
                }
              >
                <option value="">Choose the OpenGeni bot</option>
                {storedBotMissing ? (
                  <option value={props.connectionId} disabled>
                    The selected bot is unavailable
                  </option>
                ) : null}
                {botOptions.map((option) => (
                  <option key={option.connection.id} value={option.connection.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label>Channel</Label>
            <Select
              value={props.channelId}
              disabled={props.disabled || !effectiveConnectionId || channelsLoading}
              onChange={(event) =>
                props.onChange({
                  connectionId: event.target.value ? effectiveConnectionId : props.connectionId,
                  channelId: event.target.value,
                })
              }
            >
              <option value="">{channelsLoading ? "Loading channels…" : "Don't post"}</option>
              {storedChannelMissing ? (
                <option value={props.channelId} disabled>
                  The chosen channel is unavailable
                </option>
              ) : null}
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name ? `#${channel.name}` : channel.id}
                  {channel.isPrivate ? " (private)" : ""}
                </option>
              ))}
            </Select>
            {channelsError ? (
              <p role="alert" className="text-xs text-status-failed">
                Slack channels could not be loaded. {channelsError}
              </p>
            ) : null}
          </div>
        </>
      )}
    </FormDisclosure>
  );
}
