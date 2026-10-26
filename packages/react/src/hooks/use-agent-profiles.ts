import type {
  AgentProfile,
  CreateAgentProfileRequest,
  OpenGeniClient,
  Session,
  UpdateAgentProfileRequest,
  UpdateSessionAgentIdentityRequest,
} from "@opengeni/sdk";
import { OpenGeniAgentProfilesClient } from "@opengeni/sdk/agent-profiles";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

/* ----------------------------------------------------------------------------
   Agent profiles: reusable, workspace-shared agents (name, role, avatar and
   the configuration a chat starts from). One client/workspace cache is shared
   by every consumer (rail, composer chip, chat header, Agents page) so the
   list is read once. Profile calls need a full client with `requestJson`;
   embedded session-only clients do not have one, and the feature stays off.
   -------------------------------------------------------------------------- */

type ProfileTransport = Pick<OpenGeniClient, "requestJson">;

export type AgentProfileCacheSnapshot = Readonly<{
  profiles: readonly AgentProfile[];
  ready: boolean;
}>;

type AgentProfileCache = Readonly<{
  getSnapshot: () => AgentProfileCacheSnapshot;
  subscribe: (listener: () => void) => () => void;
  beginLoad: () => number;
  acceptLoad: (ticket: number, profiles: readonly AgentProfile[]) => void;
  upsert: (profile: AgentProfile) => void;
}>;

const EMPTY: AgentProfileCacheSnapshot = { profiles: [], ready: false };
const caches = new WeakMap<object, Map<string, AgentProfileCache>>();

function ordered(profiles: readonly AgentProfile[]): AgentProfile[] {
  return [...profiles].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function createCache(): AgentProfileCache {
  let snapshot = EMPTY;
  let nextTicket = 0;
  let acceptedTicket = 0;
  const listeners = new Set<() => void>();
  const publish = (profiles: readonly AgentProfile[]) => {
    snapshot = { profiles, ready: true };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginLoad: () => ++nextTicket,
    acceptLoad: (ticket, profiles) => {
      if (ticket < acceptedTicket) return;
      acceptedTicket = ticket;
      publish(ordered(profiles));
    },
    upsert: (profile) => {
      const rest = snapshot.profiles.filter((candidate) => candidate.id !== profile.id);
      publish(ordered(profile.status === "active" ? [...rest, profile] : rest));
    },
  };
}

function cacheFor(client: object, workspaceId: string): AgentProfileCache {
  let byWorkspace = caches.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    caches.set(client, byWorkspace);
  }
  let cache = byWorkspace.get(workspaceId);
  if (!cache) {
    cache = createCache();
    byWorkspace.set(workspaceId, cache);
  }
  return cache;
}

/** The profiles client for this session client, or null when it cannot make the calls. */
export function agentProfilesClientFor(client: unknown): OpenGeniAgentProfilesClient | null {
  const transport = client as Partial<ProfileTransport> | null;
  if (!transport || typeof transport.requestJson !== "function") return null;
  return new OpenGeniAgentProfilesClient(transport as ProfileTransport);
}

export type UseAgentProfilesOptions = ClientOverride & {
  /** Read only when the deployment has the feature on. */
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type UseAgentProfilesResult = {
  /** Active profiles, by name. */
  profiles: AgentProfile[];
  /** Whether profile calls are possible with this client. */
  available: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  get: (profileId: string) => Promise<AgentProfile | null>;
  create: (request: CreateAgentProfileRequest) => Promise<AgentProfile | null>;
  update: (profileId: string, request: UpdateAgentProfileRequest) => Promise<AgentProfile | null>;
  archive: (profileId: string) => Promise<AgentProfile | null>;
  restore: (profileId: string) => Promise<AgentProfile | null>;
  /** Switch a chat to a profile from its next message. */
  applyToSession: (
    sessionId: string,
    agentProfileId: string,
    expectedVersion: number,
  ) => Promise<Session | null>;
  /** Name only this chat's agent, or clear it with null. */
  setSessionIdentity: (
    sessionId: string,
    identity: UpdateSessionAgentIdentityRequest["identity"],
  ) => Promise<Session | null>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

export function useAgentProfiles(options: UseAgentProfilesOptions = {}): UseAgentProfilesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const profilesClient = useMemo(() => agentProfilesClientFor(client), [client]);
  const enabled = options.enabled !== false && profilesClient !== null;
  const cache = useMemo(() => cacheFor(client, workspaceId), [client, workspaceId]);
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot);
  const load = useCallback(async () => {
    if (!profilesClient) return [];
    const ticket = cache.beginLoad();
    const { profiles } = await profilesClient.listAgentProfiles(workspaceId);
    cache.acceptLoad(ticket, profiles);
    return profiles;
  }, [cache, profilesClient, workspaceId]);
  const { loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    enabled,
  });
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();

  const withProfile = useCallback(
    async (call: (api: OpenGeniAgentProfilesClient) => Promise<AgentProfile>) => {
      if (!profilesClient) return null;
      const result = await run(() => call(profilesClient));
      if (result) cache.upsert(result);
      return result;
    },
    [cache, profilesClient, run],
  );

  const get = useCallback(
    async (profileId: string) =>
      profilesClient
        ? await run(() => profilesClient.getAgentProfile(workspaceId, profileId))
        : null,
    [profilesClient, run, workspaceId],
  );
  const create = useCallback(
    (request: CreateAgentProfileRequest) =>
      withProfile((api) => api.createAgentProfile(workspaceId, request)),
    [withProfile, workspaceId],
  );
  const update = useCallback(
    (profileId: string, request: UpdateAgentProfileRequest) =>
      withProfile((api) => api.updateAgentProfile(workspaceId, profileId, request)),
    [withProfile, workspaceId],
  );
  const archive = useCallback(
    (profileId: string) => withProfile((api) => api.archiveAgentProfile(workspaceId, profileId)),
    [withProfile, workspaceId],
  );
  const restore = useCallback(
    (profileId: string) => withProfile((api) => api.restoreAgentProfile(workspaceId, profileId)),
    [withProfile, workspaceId],
  );
  const applyToSession = useCallback(
    async (sessionId: string, agentProfileId: string, expectedVersion: number) =>
      profilesClient
        ? await run(() =>
            profilesClient.applySessionAgentProfile(workspaceId, sessionId, {
              agentProfileId,
              expectedVersion,
            }),
          )
        : null,
    [profilesClient, run, workspaceId],
  );
  const setSessionIdentity = useCallback(
    async (sessionId: string, identity: UpdateSessionAgentIdentityRequest["identity"]) =>
      profilesClient
        ? await run(() =>
            profilesClient.updateSessionAgentIdentity(workspaceId, sessionId, { identity }),
          )
        : null,
    [profilesClient, run, workspaceId],
  );

  return {
    profiles: snapshot.profiles as AgentProfile[],
    available: profilesClient !== null,
    loading: enabled && loading && !snapshot.ready,
    error,
    refresh,
    get,
    create,
    update,
    archive,
    restore,
    applyToSession,
    setSessionIdentity,
    mutating,
    mutationError,
    clearMutationError,
  };
}
