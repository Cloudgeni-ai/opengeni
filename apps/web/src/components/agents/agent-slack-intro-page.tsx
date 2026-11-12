/**
 * Post a short intro of an agent in Slack channels the Opengeni app is
 * already in, so people know to ask it there.
 */
import { useEffect, useMemo, useState } from "react";
import { agentInitialsAvatar, SLACK_AGENT_INTRO_CHANNELS_MAX } from "@opengeni/contracts";
import type { Agent, AgentSlackChannelListResponse, AgentSlackIntroResponse } from "@opengeni/sdk";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { apiErrorDetails, userErrorTextWithoutReference } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { CheckboxField, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import {
  previewPersonName,
  SlackAgentIntroPreview,
} from "../capabilities/slack-agent-intro-preview";
import { agentSlackCall } from "./agent-slack-section";

type IntroChannel = AgentSlackChannelListResponse["channels"][number];
type IntroStatus = AgentSlackIntroResponse["results"][number]["status"];

const INTRO_STATUS_TEXT: Record<Exclude<IntroStatus, "posted">, string> = {
  not_in_channel: "Add the Opengeni app to this channel first.",
  restricted: "Opengeni can't post in this channel. Slack limits who can post here.",
  failed: "Couldn't post here. Try again.",
};

function channelLabel(channel: IntroChannel): string {
  return channel.isPrivate
    ? `Private · ${channel.name ?? channel.id}`
    : `#${channel.name ?? channel.id}`;
}

/** Channels by name, so a long list reads like Slack's. */
export function sortIntroChannels(channels: readonly IntroChannel[]): IntroChannel[] {
  return [...channels].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: "base" }),
  );
}

/** Show the search box once the list is longer than this. */
const INTRO_SEARCH_FROM = 8;

export function AgentSlackIntroPage({
  agent,
  connectionId,
  onClose,
}: {
  agent: Agent;
  connectionId: string;
  onClose: () => void;
}) {
  const { client, accessContext } = useAppContext();
  const [channels, setChannels] = useState<IntroChannel[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [announcementChannelId, setAnnouncementChannelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, IntroStatus>>({});
  useEffect(() => {
    let live = true;
    setLoadError(null);
    void (async () => {
      try {
        const collected: IntroChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await client.listAgentSlackChannels(
            agent.workspaceId,
            agent.id,
            connectionId,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (live) {
          setChannels(
            sortIntroChannels([...new Map(collected.map((row) => [row.id, row])).values()]),
          );
        }
      } catch (failure) {
        if (live) setLoadError(failure);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, agent.workspaceId, agent.id, connectionId, revision]);
  // The organization's announcement channel, picked by default. Without it
  // (or without access to the setting) nothing is picked.
  useEffect(() => {
    let live = true;
    void client
      .getOpenGeniSlackAgentUpdateSettings(agent.workspaceId, connectionId)
      .then((settings) => {
        if (live) setAnnouncementChannelId(settings.announcementChannelId ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, agent.workspaceId, connectionId]);
  useEffect(() => {
    if (touched || !channels || !announcementChannelId) return;
    // A channel that already has this intro is not picked again.
    if (channels.some((channel) => channel.id === announcementChannelId && !channel.introduced)) {
      setSelected([announcementChannelId]);
    }
  }, [touched, channels, announcementChannelId]);
  const visible = useMemo(() => {
    const needle = query.trim().replace(/^#/u, "").toLowerCase();
    if (!channels || !needle) return channels;
    return channels.filter(
      (channel) =>
        selected.includes(channel.id) ||
        (channel.name ?? channel.id).toLowerCase().includes(needle),
    );
  }, [channels, query, selected]);
  const full = selected.length >= SLACK_AGENT_INTRO_CHANNELS_MAX;
  const empty = channels !== null && channels.length === 0;
  const handle = agent.slack.find((row) => row.connectionId === connectionId)?.handle;
  return (
    <FormPage
      title={`Introduce ${agent.name}`}
      description={
        handle
          ? `Post a short intro so people know to ask ${agentSlackCall(agent.name)}.`
          : "Post a short intro so people know to ask it."
      }
      back={{ label: agent.name, onClick: onClose }}
      onCancel={onClose}
      submitLabel="Post intro"
      pendingLabel="Posting…"
      submitDisabled={selected.length === 0}
      disabledReason={channels && !empty ? "Pick at least one channel." : undefined}
      onSubmit={async () => {
        const response = await client.postAgentSlackIntro(
          agent.workspaceId,
          agent.id,
          connectionId,
          { channelIds: selected },
        );
        const byChannel = Object.fromEntries(
          response.results.map((result) => [result.channelId, result.status]),
        );
        const failed = response.results.filter((result) => result.status !== "posted");
        const posted = response.results.length - failed.length;
        if (failed.length === 0) {
          toast.success(
            posted === 1 ? "Intro posted in 1 channel" : `Intro posted in ${posted} channels`,
          );
          onClose();
          return true;
        }
        setResults(byChannel);
        // Keep the channels a retry could fix.
        setTouched(true);
        setSelected(
          failed
            .filter((result) => result.status !== "restricted")
            .map((result) => result.channelId),
        );
        return false;
      }}
    >
      <FieldStack>
        <SlackAgentIntroPreview
          name={agent.name}
          description={agent.description}
          avatar={agent.avatar ?? agentInitialsAvatar(agent.name, agent.id)}
          workspaceId={agent.workspaceId}
          seed={agent.id}
          addedBy={previewPersonName(accessContext?.subjectLabel)}
        />
        {loadError ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't load Slack channels"
            {...apiErrorDetails(loadError)}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Try again
              </Button>
            }
          >
            {userErrorTextWithoutReference(loadError)}
          </ErrorMessage>
        ) : channels === null || visible === null ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading channels">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-56" />
          </div>
        ) : empty ? (
          <p className="text-sm text-fg-muted">
            Opengeni isn't in any channels yet. Invite @Opengeni to a channel in Slack, then come
            back.
          </p>
        ) : (
          <fieldset className="grid gap-3" aria-label="Channels">
            {channels.length > INTRO_SEARCH_FROM ? (
              <TextInput
                type="search"
                aria-label="Search channels"
                placeholder="Search channels"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
            {visible.map((channel) => {
              const checked = selected.includes(channel.id);
              const status = results[channel.id];
              const blocked = status === "restricted";
              return (
                <CheckboxField
                  key={channel.id}
                  label={channelLabel(channel)}
                  description={
                    status === "posted"
                      ? "Posted."
                      : status
                        ? INTRO_STATUS_TEXT[status]
                        : channel.introduced
                          ? "Intro already posted."
                          : undefined
                  }
                  checked={checked}
                  disabled={!checked && (full || blocked)}
                  onCheckedChange={(next) => {
                    setTouched(true);
                    setSelected((current) =>
                      next ? [...current, channel.id] : current.filter((id) => id !== channel.id),
                    );
                  }}
                />
              );
            })}
            {visible.length === 0 ? (
              <p className="text-sm text-fg-muted">No channels match.</p>
            ) : null}
            {full ? (
              <p className="text-xs text-fg-muted">
                Up to {SLACK_AGENT_INTRO_CHANNELS_MAX} channels at a time.
              </p>
            ) : null}
          </fieldset>
        )}
      </FieldStack>
    </FormPage>
  );
}
