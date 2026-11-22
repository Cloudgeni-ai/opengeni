/**
 * Test kit for the agents UI: agents as the API returns them, a client that
 * keeps them in memory and records calls, and a host with in-memory
 * navigation. Tests only.
 */
import type { ReactNode } from "react";
import type {
  Agent,
  AgentChat,
  AgentSummary,
  CreateAgentRequest,
  ListAgentSlackInstallsResponse,
  UpdateAgentRequest,
} from "@opengeni/contracts";

import { AppContext, type AppContextValue } from "../src/app/app-context";
import { AppHostProvider, type AppHost } from "../src/app/lib/app-host";
import { useMemoryNavigation } from "../src/app/embed/memory-navigation";
import type { NavigationLocation } from "../src/app/lib/navigation";

export const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

let counter = 0;
function uuid(): string {
  counter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, "0")}`;
}

export function makeAgent(patch: Partial<Agent> = {}): Agent {
  const id = patch.id ?? uuid();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: "Release manager",
    description: "Plans and checks our weekly releases",
    avatar: null,
    visibility: "workspace",
    ownerSubjectId: null,
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: "user-me",
    revision: 1,
    hasFirstMessage: false,
    memory: { enabled: false, collectionId: null, scope: "workspace", reviewFirst: false },
    toolPermissions: [],
    skills: [],
    templateKey: null,
    slack: [],
    viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: true },
    version: 1,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-30T09:00:00.000Z",
    instructions: "",
    firstMessage: "",
    revisionCreatedBySubjectId: "user-me",
    revisionCreatedAt: "2026-10-30T09:00:00.000Z",
    ...patch,
  };
}

export function summary(agent: Agent): AgentSummary {
  const {
    instructions: _instructions,
    firstMessage: _firstMessage,
    revisionCreatedBySubjectId: _by,
    revisionCreatedAt: _at,
    ...rest
  } = agent;
  return rest;
}

export type FakeAgentsClient = ReturnType<typeof fakeAgentsClient>;

/** A client holding agents in memory. Each call is recorded as `[method, ...args]`. */
export function fakeAgentsClient(
  initial: Agent[],
  options: {
    chats?: AgentChat[];
    slack?: ListAgentSlackInstallsResponse;
    session?: Record<string, unknown>;
    yours?: (agent: Agent) => boolean;
    /** Whether Only me chats are available here (default yes). */
    canCreatePrivate?: boolean;
    /** Holds getAgent until the test releases it. */
    holdGetAgent?: boolean;
    /** Ready-made agents for the gallery and suggested triggers. */
    templates?: unknown[];
    /** Automations; those with `agentConfig.agentId` are an agent's triggers. */
    tasks?: unknown[];
    /** Capability catalog items, for Can use. */
    capabilities?: unknown[];
    /** Tools per capability id, for Can use's per-tool rows. */
    connectorTools?: Record<string, string[]>;
    /** Knowledge entries in an agent's Memory collection. */
    memoryEntries?: unknown[];
    /** Workspace Skills by stable key. */
    skills?: string[];
    /** Event sources automations listen to. */
    eventSources?: {
      id: string;
      name: string;
      kind?: string;
      status?: string;
      [field: string]: unknown;
    }[];
    /** Makes createScheduledTask fail with this error. */
    createTaskError?: unknown;
    /** Chats in the workspace, with the agent each was started with. */
    sessions?: { id: string; title: string; agentId?: string | null }[] | undefined;
    /** Chats per page of the session list (default 100). */
    sessionsPageSize?: number | undefined;
    /** Makes reading the session list fail with this error. */
    sessionsError?: unknown;
    /** Agent chats per page (default 100). */
    chatsPageSize?: number | undefined;
    /** Makes reading an agent's chats fail with this error. */
    chatsError?: unknown;
    /** Makes createEventSource fail with this error. */
    createSourceError?: unknown;
    updateSourceError?: unknown;
  } = {},
) {
  const agents = new Map(initial.map((agent) => [agent.id, agent]));
  const calls: unknown[][] = [];
  const createdSources = new Map<string, Record<string, unknown>>();
  const held: Array<() => void> = [];
  const find = (id: string) => {
    const agent = agents.get(id);
    if (!agent) throw Object.assign(new Error("Not found"), { status: 404 });
    return agent;
  };
  return {
    calls,
    agents,
    async listAgents(workspaceId: string, request: { filter?: string } = {}) {
      calls.push(["listAgents", workspaceId, request]);
      const all = [...agents.values()];
      return (request.filter === "yours" ? all.filter(options.yours ?? (() => true)) : all).map(
        summary,
      );
    },
    async getAgent(workspaceId: string, id: string) {
      calls.push(["getAgent", workspaceId, id]);
      if (options.holdGetAgent) await new Promise<void>((resolve) => held.push(resolve));
      return find(id);
    },
    /** Answers every held getAgent. */
    releaseGetAgent() {
      for (const resolve of held.splice(0)) resolve();
    },
    async getSessionTenancyCreateCapabilities(workspaceId: string) {
      calls.push(["getSessionTenancyCreateCapabilities", workspaceId]);
      const canCreatePrivate = options.canCreatePrivate ?? true;
      return {
        activated: canCreatePrivate,
        canCreatePrivate,
        reason: canCreatePrivate ? "available" : "not_activated",
      };
    },
    async createAgent(workspaceId: string, request: CreateAgentRequest) {
      calls.push(["createAgent", workspaceId, request]);
      const created = makeAgent({
        name: request.name,
        description: request.description ?? "",
        avatar: request.avatar ?? null,
        visibility: request.visibility ?? "workspace",
        instructions: request.instructions ?? "",
        firstMessage: request.firstMessage ?? "",
        sourceSessionId: request.sourceSessionId ?? null,
      });
      agents.set(created.id, created);
      return created;
    },
    async updateAgent(workspaceId: string, id: string, request: UpdateAgentRequest) {
      calls.push(["updateAgent", workspaceId, id, request]);
      const current = find(id);
      const { expectedVersion: _version, memoryEnabled, ...rest } = request;
      const next: Agent = {
        ...current,
        ...(rest as Partial<Agent>),
        memory:
          memoryEnabled === undefined
            ? current.memory
            : { ...current.memory, enabled: memoryEnabled },
        version: current.version + 1,
      };
      agents.set(id, next);
      return next;
    },
    async deleteAgent(workspaceId: string, id: string) {
      calls.push(["deleteAgent", workspaceId, id]);
      agents.delete(id);
      return { deleted: true };
    },
    async listAgentTemplates(workspaceId: string) {
      calls.push(["listAgentTemplates", workspaceId]);
      return options.templates ?? [];
    },
    async createAgentFromTemplate(workspaceId: string, key: string) {
      calls.push(["createAgentFromTemplate", workspaceId, key]);
      const template = (options.templates ?? []).find(
        (entry) => (entry as { key: string }).key === key,
      ) as { name: string; description: string; instructions: string } | undefined;
      if (!template) throw Object.assign(new Error("Not found"), { status: 404 });
      const created = makeAgent({
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        templateKey: key,
      });
      agents.set(created.id, created);
      return created;
    },
    async listScheduledTasks(workspaceId: string, request: unknown) {
      calls.push(["listScheduledTasks", workspaceId, request]);
      return options.tasks ?? [];
    },
    async pauseScheduledTask(workspaceId: string, id: string) {
      calls.push(["pauseScheduledTask", workspaceId, id]);
      const task = (options.tasks ?? []).find((entry) => (entry as { id: string }).id === id);
      return { ...(task as object), status: "paused" };
    },
    async resumeScheduledTask(workspaceId: string, id: string) {
      calls.push(["resumeScheduledTask", workspaceId, id]);
      const task = (options.tasks ?? []).find((entry) => (entry as { id: string }).id === id);
      return { ...(task as object), status: "active" };
    },
    async deleteScheduledTask(workspaceId: string, id: string) {
      calls.push(["deleteScheduledTask", workspaceId, id]);
      return { deleted: true };
    },
    async listEventSources(workspaceId: string) {
      calls.push(["listEventSources", workspaceId]);
      return options.eventSources ?? [];
    },
    catalogAssetUrl(path: string | null) {
      return path ? `/assets/${path}` : null;
    },
    async listReadyEventSources(workspaceId: string) {
      calls.push(["listReadyEventSources", workspaceId]);
      return [];
    },
    async listSessions(workspaceId: string) {
      calls.push(["listSessions", workspaceId]);
      if (options.sessionsError) throw options.sessionsError;
      return options.sessions ?? [];
    },
    async listSessionPage(workspaceId: string, query: { cursor?: string; limit?: number }) {
      calls.push(["listSessionPage", workspaceId, query.cursor ?? null]);
      if (options.sessionsError) throw options.sessionsError;
      const all = options.sessions ?? [];
      const size = Math.min(options.sessionsPageSize ?? 100, query.limit ?? 100);
      const start = Number(query.cursor ?? 0);
      const end = start + size;
      return {
        pinned: [],
        sessions: all.slice(start, end),
        nextCursor: end < all.length ? String(end) : null,
      };
    },
    async listEventSourceTypes(workspaceId: string, sourceId: string) {
      calls.push(["listEventSourceTypes", workspaceId, sourceId]);
      return [];
    },
    async createEventSource(workspaceId: string, request: Record<string, unknown>) {
      calls.push(["createEventSource", workspaceId, request]);
      if (options.createSourceError) throw options.createSourceError;
      const id = uuid();
      const kind = String(request.kind);
      // An app's webhook (Linear, Sentry) waits for the secret that app shows.
      const pasted = kind === "webhook" && request.adapter === "custom";
      const awaiting = pasted && request.signingSecret === undefined;
      const source = {
        id,
        workspaceId,
        kind,
        adapter: (request.adapter as string | undefined) ?? null,
        format: (request.format as unknown) ?? null,
        name: (request.name as string | undefined) ?? kind,
        status: awaiting ? "blocked" : "active",
        statusReasonCode: awaiting ? "awaiting_secret" : null,
        statusReason: awaiting ? "Paste the signing secret." : null,
        awaitingSigningSecret: awaiting,
        mcp: null,
        webhookUrl: kind === "webhook" ? `https://hooks.example.com/${id}` : null,
      };
      createdSources.set(id, source);
      return {
        source,
        ...(kind === "webhook" && !pasted ? { signingSecret: "whsec_test" } : {}),
      };
    },
    async updateEventSource(
      workspaceId: string,
      sourceId: string,
      request: Record<string, unknown>,
    ) {
      calls.push(["updateEventSource", workspaceId, sourceId, request]);
      if (options.updateSourceError) throw options.updateSourceError;
      const current =
        createdSources.get(sourceId) ??
        (options.eventSources ?? []).find((source) => source.id === sourceId);
      if (!current) throw new Error(`no source ${sourceId}`);
      const updated =
        request.signingSecret !== undefined
          ? {
              ...current,
              status: "active",
              statusReasonCode: null,
              statusReason: null,
              awaitingSigningSecret: false,
            }
          : current;
      createdSources.set(sourceId, updated);
      return updated;
    },
    async createScheduledTask(workspaceId: string, request: Record<string, unknown>) {
      calls.push(["createScheduledTask", workspaceId, request]);
      if (options.createTaskError) throw options.createTaskError;
      return {
        id: uuid(),
        status: "active",
        ...request,
        events: request.events ?? null,
      };
    },
    async listCapabilities(workspaceId: string) {
      calls.push(["listCapabilities", workspaceId]);
      return { items: options.capabilities ?? [] };
    },
    async getConnectorToolPermissions(workspaceId: string, id: string) {
      calls.push(["getConnectorToolPermissions", workspaceId, id]);
      return { tools: (options.connectorTools?.[id] ?? []).map((name) => ({ name })) };
    },
    async listKnowledgeEntries(workspaceId: string, request: unknown) {
      calls.push(["listKnowledgeEntries", workspaceId, request]);
      return { entries: options.memoryEntries ?? [], nextCursor: null };
    },
    async getKnowledgeEntry(workspaceId: string, id: string) {
      calls.push(["getKnowledgeEntry", workspaceId, id]);
      const entry = (options.memoryEntries ?? []).find(
        (row) => (row as { id: string }).id === id,
      ) as { version: number; revision: { title: string; preview: string } } | undefined;
      if (!entry) throw Object.assign(new Error("Not found"), { status: 404 });
      return {
        ...entry,
        revision: { ...entry.revision, entry: { content: entry.revision.preview } },
      };
    },
    async saveKnowledgeEntry(workspaceId: string, request: Record<string, unknown>) {
      calls.push(["saveKnowledgeEntry", workspaceId, request]);
      return { status: "active", entryId: request.entryId, version: 2 };
    },
    async archiveKnowledgeEntry(workspaceId: string, id: string, request: unknown) {
      calls.push(["archiveKnowledgeEntry", workspaceId, id, request]);
      return { archived: true };
    },
    async listWorkspaceSkills(workspaceId: string, request: unknown) {
      calls.push(["listWorkspaceSkills", workspaceId, request]);
      return {
        skills: (options.skills ?? []).map((stableKey) => ({
          id: `skill-${stableKey}`,
          stableKey,
          title: null,
          description: null,
        })),
        nextCursor: null,
      };
    },
    async listAgentChats(workspaceId: string, id: string, request: Record<string, unknown>) {
      calls.push(["listAgentChats", workspaceId, id, request]);
      if (options.chatsError) throw options.chatsError;
      if (options.chats || !options.sessions)
        return { chats: options.chats ?? [], nextCursor: null as string | null };
      // Chats in the workspace with this agent, filtered as the server does.
      const all = options.sessions
        .filter((session) => session.agentId === id)
        .map(
          (session): AgentChat => ({
            sessionId: session.id,
            title: session.title,
            visibility: "workspace",
            createdBySubjectId: null,
            source: "app",
            slack: null,
            createdAt: "2026-11-21T00:00:00.000Z",
            updatedAt: "2026-11-21T00:00:00.000Z",
          }),
        );
      const size = Math.min(options.chatsPageSize ?? 100, Number(request.limit ?? 100));
      const start = Number(request.cursor ?? 0);
      const end = start + size;
      return {
        chats: all.slice(start, end),
        nextCursor: end < all.length ? String(end) : null,
      };
    },
    async listAgentSlackInstalls(workspaceId: string, id: string) {
      calls.push(["listAgentSlackInstalls", workspaceId, id]);
      return options.slack ?? { installs: [], routingEnabled: true };
    },
    async getSession(workspaceId: string, id: string) {
      calls.push(["getSession", workspaceId, id]);
      return { id, workspaceId, title: null, description: null, avatar: null, ...options.session };
    },
    async getSessionConfiguration(workspaceId: string, id: string) {
      calls.push(["getSessionConfiguration", workspaceId, id]);
      return { id, workspaceId, title: null, description: null, avatar: null, ...options.session };
    },
    /** An image avatar's file: not reachable here, so the avatar shows its fallback. */
    async getRetainedArtifact(workspaceId: string, id: string): Promise<never> {
      calls.push(["getRetainedArtifact", workspaceId, id]);
      throw new Error("not found");
    },
  };
}

export function appContext(
  client: object,
  patch: Partial<Record<keyof AppContextValue, unknown>> = {},
): AppContextValue {
  return {
    client,
    workspaces: [{ id: WORKSPACE_ID, name: "Platform", kind: "shared", accountId: "account-1" }],
    accessContext: {
      subjectId: "user-me",
      subjectLabel: "Maja",
      workspaceGrants: [],
      accountGrants: [
        {
          accountId: "account-1",
          subjectId: "user-me",
          permissions: ["account:read"],
          metadata: { accountName: "Acme" },
        },
      ],
    },
    managedSelfContext: null,
    ...patch,
  } as unknown as AppContextValue;
}

function Navigation({
  path,
  onLocation,
  children,
}: {
  path: string;
  onLocation?: ((location: NavigationLocation) => void) | undefined;
  children: ReactNode;
}) {
  const navigation = useMemoryNavigation({
    initialPath: path,
    consoleOrigin: "https://app.example.test",
    handles: () => true,
    onLocationChange: onLocation,
  });
  return <AppHostProvider host={{ navigation } as unknown as AppHost}>{children}</AppHostProvider>;
}

export function AgentsTestHost({
  context,
  path = `/workspaces/${WORKSPACE_ID}/agents`,
  onLocation,
  children,
}: {
  context: AppContextValue;
  path?: string | undefined;
  onLocation?: ((location: NavigationLocation) => void) | undefined;
  children: ReactNode;
}) {
  return (
    <Navigation path={path} onLocation={onLocation}>
      <AppContext.Provider value={context}>{children}</AppContext.Provider>
    </Navigation>
  );
}
