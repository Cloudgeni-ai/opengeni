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
  } = {},
) {
  const agents = new Map(initial.map((agent) => [agent.id, agent]));
  const calls: unknown[][] = [];
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
    async listAgentChats(workspaceId: string, id: string, request: Record<string, unknown>) {
      calls.push(["listAgentChats", workspaceId, id, request]);
      return { chats: options.chats ?? [], nextCursor: null as string | null };
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
  };
}

export function appContext(
  client: object,
  patch: Partial<Record<keyof AppContextValue, unknown>> = {},
): AppContextValue {
  return {
    client,
    workspaces: [{ id: WORKSPACE_ID, name: "Platform", kind: "shared", accountId: "account-1" }],
    accessContext: { subjectId: "user-me", subjectLabel: "Maja", workspaceGrants: [] },
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
