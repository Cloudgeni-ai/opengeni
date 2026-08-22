import type { Channel } from "@opengeni/sdk";
import type { SessionClientLike } from "../client";

type PendingChannel = { channel: Channel; committedAfterLoad: number };

export type ChannelCacheSnapshot = Readonly<{
  channels: readonly Channel[];
  ready: boolean;
}>;

export type ChannelCacheStore = Readonly<{
  getSnapshot: () => ChannelCacheSnapshot;
  subscribe: (listener: () => void) => () => void;
  beginLoad: () => number;
  acceptLoad: (ticket: number, channels: readonly Channel[]) => void;
  publishCreated: (channel: Channel) => void;
}>;

const EMPTY_CHANNELS: readonly Channel[] = [];
const EMPTY_SNAPSHOT: ChannelCacheSnapshot = {
  channels: EMPTY_CHANNELS,
  ready: false,
};
const channelCaches = new WeakMap<object, Map<string, ChannelCacheStore>>();

function compareChannels(left: Channel, right: Channel): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    left.sortOrder - right.sortOrder ||
    left.id.localeCompare(right.id)
  );
}

function orderedChannels(channels: readonly Channel[]): Channel[] {
  return [...channels].sort(compareChannels);
}

function upsertChannel(channels: readonly Channel[], channel: Channel): Channel[] {
  const next = channels.filter((candidate) => candidate.id !== channel.id);
  next.push(channel);
  return orderedChannels(next);
}

/**
 * One client/workspace cache shared by every useChannels consumer.
 *
 * List reads are ticketed so an older request cannot erase a newer result.
 * A successful create remains layered over the latest server snapshot until a
 * list request that started after that success reconciles it. Requests already
 * in flight cannot make the project disappear between create and session start.
 */
export function createChannelCacheStore(): ChannelCacheStore {
  let base: readonly Channel[] | null = null;
  let snapshot = EMPTY_SNAPSHOT;
  let nextLoadTicket = 0;
  let acceptedLoadTicket = 0;
  const pending = new Map<string, PendingChannel>();
  const listeners = new Set<() => void>();

  const publish = () => {
    let channels = base ?? EMPTY_CHANNELS;
    for (const { channel } of pending.values()) {
      channels = upsertChannel(channels, channel);
    }
    snapshot = { channels, ready: base !== null || pending.size > 0 };
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginLoad: () => ++nextLoadTicket,
    acceptLoad: (ticket, channels) => {
      if (ticket < acceptedLoadTicket) return;
      acceptedLoadTicket = ticket;
      base = orderedChannels(channels);
      for (const [id, created] of pending) {
        if (ticket > created.committedAfterLoad) pending.delete(id);
      }
      publish();
    },
    publishCreated: (channel) => {
      pending.set(channel.id, { channel, committedAfterLoad: nextLoadTicket });
      publish();
    },
  };
}

export function channelCacheFor(client: SessionClientLike, workspaceId: string): ChannelCacheStore {
  let byWorkspace = channelCaches.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    channelCaches.set(client, byWorkspace);
  }
  let cache = byWorkspace.get(workspaceId);
  if (!cache) {
    cache = createChannelCacheStore();
    byWorkspace.set(workspaceId, cache);
  }
  return cache;
}
