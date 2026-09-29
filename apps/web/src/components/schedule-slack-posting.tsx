import { useEffect, useMemo, useState } from "react";

import { Field } from "@/components/ui/field";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  activeOpenGeniSlackBotConnections,
  openGeniSlackBotConnectionOptions,
} from "@/lib/slack-bot";
import type { ConnectionMetadata } from "@/types";

type SlackChannelOption = { id: string; name: string | null; isPrivate: boolean };

const MAX_CHANNEL_PAGES = 5;
/** Menu value for "no channel"; a Slack channel id is never empty. */
const DONT_POST = "__dont_post__";

/**
 * The one Slack channel a scheduled task's runs may post to as the OpenGeni
 * workspace bot. A person chooses it here; the agent cannot post anywhere
 * else. Changing it needs permission to manage connections.
 *
 * Renders plain fields for the schedule form's Advanced section. Channels load
 * only once that section is open (`active`) or a channel is already chosen.
 */
export function ScheduleSlackPosting(props: {
  workspaceId: string;
  connectionId: string;
  channelId: string;
  disabled: boolean;
  /** The surrounding section is open, so the channel list is worth loading. */
  active: boolean;
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
    if (!canChoose || (!props.active && !props.channelId) || !effectiveConnectionId) {
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
  }, [
    canChoose,
    context.client,
    effectiveConnectionId,
    props.active,
    props.channelId,
    props.workspaceId,
  ]);

  const storedChannelMissing =
    Boolean(props.channelId) &&
    !channelsLoading &&
    !channels.some((channel) => channel.id === props.channelId);
  const storedBotMissing =
    Boolean(props.connectionId) &&
    bots !== null &&
    !botOptions.some((option) => option.connection.id === props.connectionId);

  const hint =
    "Each run can post to one Slack channel as the OpenGeni bot. The agent cannot post to any " +
    "other channel. Invite the bot to a channel in Slack to see it here.";
  const blocked = !canChoose
    ? "Only people who can manage connections can choose this channel."
    : botsError
      ? `Slack connections could not be loaded. ${botsError}`
      : bots !== null && botOptions.length === 0 && !props.connectionId
        ? "No OpenGeni Slack bot is installed in this workspace. A task can post only through a " +
          "bot installed in its own workspace, from Plugins."
        : null;
  if (blocked) {
    return (
      <Field label="Post to Slack" optional group>
        <p role={botsError ? "alert" : undefined} className="m-0 text-sm text-fg-muted">
          {blocked}
        </p>
      </Field>
    );
  }

  const botMenu: SelectOption[] = [
    ...(storedBotMissing
      ? [
          {
            value: props.connectionId,
            label: "The selected bot is unavailable",
            disabled: true,
          },
        ]
      : []),
    ...botOptions.map((option) => ({ value: option.connection.id, label: option.label })),
  ];
  const channelMenu: SelectOption[] = [
    { value: DONT_POST, label: "Don't post" },
    ...(storedChannelMissing
      ? [{ value: props.channelId, label: "The chosen channel is unavailable", disabled: true }]
      : []),
    ...channels.map((channel) => ({
      value: channel.id,
      label: channel.name ? `#${channel.name}` : channel.id,
      ...(channel.isPrivate ? { meta: "Private" } : {}),
    })),
  ];

  return (
    <>
      {botOptions.length > 1 || storedBotMissing ? (
        <Field label="Slack workspace">
          <SelectMenu
            options={botMenu}
            value={props.connectionId || null}
            onValueChange={(connectionId) => props.onChange({ connectionId, channelId: "" })}
            placeholder="Choose the OpenGeni bot"
            disabled={props.disabled}
            className="max-w-[360px]"
          />
        </Field>
      ) : null}
      <Field
        label="Post to Slack"
        optional
        hint={hint}
        error={channelsError ? `Slack channels could not be loaded. ${channelsError}` : undefined}
      >
        <SelectMenu
          variant={channelMenu.length > 8 ? "combobox" : "menu"}
          options={channelMenu}
          value={props.channelId || DONT_POST}
          onValueChange={(value) =>
            props.onChange(
              value === DONT_POST
                ? { connectionId: props.connectionId, channelId: "" }
                : { connectionId: effectiveConnectionId, channelId: value },
            )
          }
          placeholder="Choose the OpenGeni bot first"
          searchPlaceholder="Search channels"
          disabled={props.disabled || !effectiveConnectionId}
          loading={channelsLoading}
          loadingLabel="Loading channels…"
          className="max-w-[360px]"
        />
      </Field>
    </>
  );
}
