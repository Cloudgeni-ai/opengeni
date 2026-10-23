import { AsyncLocalStorage } from "node:async_hooks";
import { OpenGeniClient, type Session } from "@opengeni/sdk";
import { opengeniApiKey, opengeniApiUrl } from "./config";
import { isAgentIcon } from "../src/lib/agent-icons";
import { getProfile, getPrefs, listProfiles, upsertProfile, type AgentProfile } from "./db";
import {
  agentIdentity,
  composeInstructions,
  INSTRUCTIONS_VERSION,
  MAIN_AGENT_NAME,
  type AgentRole,
} from "./prompts";

const caller = new AsyncLocalStorage<Record<string, string>>();

const apiKey = opengeniApiKey();

/**
 * The browser's own credentials, so Opengeni sees the real person (and their
 * permissions), or the configured API key when this instance runs as one.
 */
export function callerHeaders(request: Request): Record<string, string> {
  if (apiKey) return { authorization: `Bearer ${apiKey}` };
  const headers: Record<string, string> = {};
  for (const name of ["cookie", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

/** Runs `work` (and everything it starts) as the person who made `request`. */
export function asCaller<T>(request: Request, work: () => Promise<T>): Promise<T> {
  return caller.run(callerHeaders(request), work);
}

export const api = new OpenGeniClient({
  baseUrl: opengeniApiUrl(),
  headers: () => caller.getStore() ?? (apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/** Opengeni metadata stamped on every session the simple app owns. */
export type SimpleAppMetadata = {
  kind: "agent" | "studio";
  role?: AgentRole;
  blank?: boolean;
};

export function simpleMetadata(session: Pick<Session, "metadata">): SimpleAppMetadata | null {
  const value = session.metadata?.simpleApp;
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "agent" || kind === "studio" ? (value as SimpleAppMetadata) : null;
}

export const EFFORT_LEVELS = {
  fast: "low",
  balanced: "medium",
  thorough: "high",
} as const;
export type EffortLevel = keyof typeof EFFORT_LEVELS;
export const DEFAULT_EFFORT: EffortLevel = "balanced";

export function effortFor(workspaceId: string, profile?: AgentProfile | null) {
  const prefs = getPrefs(workspaceId);
  const level = (profile?.effort ?? prefs.defaultEffort ?? DEFAULT_EFFORT) as EffortLevel;
  return EFFORT_LEVELS[level] ?? EFFORT_LEVELS[DEFAULT_EFFORT];
}

let agentsChannel = new Map<string, string | null>();

/** An "Agents" project keeps the app's chats together in the full Opengeni app. */
async function agentsChannelId(workspaceId: string): Promise<string | null> {
  if (agentsChannel.has(workspaceId)) return agentsChannel.get(workspaceId) ?? null;
  try {
    const channels = await api.listChannels(workspaceId);
    const existing = channels.find((channel) => channel.name === "Agents");
    const id = existing?.id ?? (await api.createChannel(workspaceId, { name: "Agents" })).id;
    agentsChannel.set(workspaceId, id);
    return id;
  } catch (error) {
    console.warn("Could not prepare the Agents project", error);
    agentsChannel.set(workspaceId, null);
    return null;
  }
}

let privateSupport = new Map<string, boolean>();
async function canCreatePrivate(workspaceId: string) {
  if (!privateSupport.has(workspaceId)) {
    try {
      const capabilities = await api.getSessionTenancyCreateCapabilities(workspaceId);
      privateSupport.set(workspaceId, capabilities.canCreatePrivate);
    } catch {
      privateSupport.set(workspaceId, false);
    }
  }
  return privateSupport.get(workspaceId) ?? false;
}

export type CreateAgentInput = {
  workspaceId: string;
  role: AgentRole;
  name: string;
  icon?: string | null;
  description?: string | null;
  instructions?: string | null;
  firstMessage?: string | null;
  /** Ordinary model-visible context attached to the first message. */
  modelContext?: string | null;
  shared?: boolean;
  blank?: boolean;
  idempotencyKey: string;
};

export async function createAgent(input: CreateAgentInput): Promise<Session> {
  const shared = input.shared ?? false;
  // Personal agents are private with personal memory where the deployment knows
  // who the person is; single-user local mode has no such identity.
  const personal = !shared && (await canCreatePrivate(input.workspaceId));
  const visibility = personal ? "private" : "workspace";
  const channelId = await agentsChannelId(input.workspaceId);
  const created = await api.createSession(input.workspaceId, {
    idempotencyKey: input.idempotencyKey,
    keepLive: true,
    visibility,
    memoryScope: personal ? "user" : "workspace",
    reasoningEffort: effortFor(input.workspaceId),
    metadata: {
      simpleApp: {
        kind: "agent",
        role: input.role,
        ...(input.blank ? { blank: true } : {}),
        shared,
      },
    },
    ...(channelId ? { channelId } : {}),
    agent: {
      capabilities: "all",
      identity: agentIdentity({
        name: input.name,
        role: input.role,
        description: input.description,
      }),
      instructions: composeInstructions({
        role: input.role,
        customInstructions: input.instructions,
        blank: input.blank,
      }),
    },
    // Without a first message the session is an empty shell (no turn yet);
    // the API spells that start mode "realtime".
    ...(input.firstMessage?.trim()
      ? {
          initialMessage: input.firstMessage.trim(),
          ...(input.modelContext?.trim() ? { modelContext: input.modelContext.trim() } : {}),
        }
      : { startMode: "realtime" as const }),
  } as Parameters<typeof api.createSession>[1]);
  // Creation takes no title; name the chat right away so lists never show a placeholder.
  const session =
    created.title === input.name
      ? created
      : await api
          .updateSession(input.workspaceId, created.id, { title: input.name })
          .catch(() => created);
  upsertProfile(input.workspaceId, session.id, {
    name: input.name,
    role: input.role,
    icon: input.icon ?? null,
    description: input.description ?? null,
    customInstructions: input.instructions ?? null,
    instructionsVersion: INSTRUCTIONS_VERSION,
  });
  return session;
}

export function isMainAgent(session: Session) {
  const metadata = simpleMetadata(session);
  return metadata?.kind === "agent" && metadata.role === "main";
}

/**
 * Every agent chat in the workspace. Agents are filed in the Agents project, so
 * that project is read in full; the newest root chats and the agents this app
 * already knows cover agents made before the project existed. A busy workspace
 * therefore never pushes an agent out of the sidebar.
 */
export async function listAgentSessions(workspaceId: string) {
  const found = new Map<string, Session>();
  const add = (session: Session) => {
    if (simpleMetadata(session)?.kind === "agent") found.set(session.id, session);
  };
  const channelId = await agentsChannelId(workspaceId);
  const [recent] = await Promise.all([
    api.listSessions(workspaceId, { parentSessionId: null, limit: 200 }),
    channelId ? readChannel(workspaceId, channelId, add) : null,
  ]);
  for (const session of recent) add(session);
  const missing = listProfiles(workspaceId).filter((profile) => !found.has(profile.sessionId));
  const known = await Promise.all(
    missing.map((profile) => api.getSession(workspaceId, profile.sessionId).catch(() => null)),
  );
  for (const session of known) if (session) add(session);
  return [...found.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readChannel(workspaceId: string, channelId: string, add: (s: Session) => void) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await api
      .listSessionPage(workspaceId, {
        channelId,
        parentSessionId: null,
        limit: 200,
        includePinned: false,
        ...(cursor ? { cursor } : {}),
      })
      .catch((error: unknown) => {
        console.warn("Could not read the Agents project", error);
        return null;
      });
    if (!result) return;
    for (const session of result.sessions) add(session);
    if (!result.nextCursor) return;
    cursor = result.nextCursor;
  }
}

let ensuringMain = new Map<string, Promise<Session>>();

/** Every workspace gets exactly one Geni, created on first visit. */
export async function ensureMainAgent(workspaceId: string): Promise<Session> {
  const pending = ensuringMain.get(workspaceId);
  if (pending) return await pending;
  const work = (async () => {
    const existing = (await listAgentSessions(workspaceId)).find(isMainAgent);
    if (existing) return existing;
    return await createAgent({
      workspaceId,
      role: "main",
      name: MAIN_AGENT_NAME,
      description: "Your main agent. Ask for anything.",
      idempotencyKey: `simple-app:main:${workspaceId}`,
    });
  })();
  ensuringMain.set(workspaceId, work);
  try {
    return await work;
  } finally {
    ensuringMain.delete(workspaceId);
  }
}

/** Re-apply the shared instructions after INSTRUCTIONS_VERSION changes. */
export async function refreshAgentInstructions(workspaceId: string, sessions: Session[]) {
  const profiles = new Map(
    listProfiles(workspaceId).map((profile) => [profile.sessionId, profile]),
  );
  for (const session of sessions) {
    const profile = profiles.get(session.id);
    if (profile && profile.instructionsVersion >= INSTRUCTIONS_VERSION) continue;
    const metadata = simpleMetadata(session);
    const role = metadata?.role ?? "agent";
    try {
      await applyAgentConfig(workspaceId, session, {
        role,
        name: profile?.name ?? session.title ?? MAIN_AGENT_NAME,
        description: profile?.description ?? null,
        customInstructions: profile?.customInstructions ?? null,
        blank: Boolean(metadata?.blank) && !profile?.customInstructions,
      });
      upsertProfile(workspaceId, session.id, {
        instructionsVersion: INSTRUCTIONS_VERSION,
        role,
      });
    } catch (error) {
      console.warn(`Could not refresh instructions for ${session.id}`, error);
    }
  }
}

export async function applyAgentConfig(
  workspaceId: string,
  session: Session,
  input: {
    role: AgentRole;
    name: string;
    description: string | null;
    customInstructions: string | null;
    blank: boolean;
  },
) {
  await api.updateSessionAgent(workspaceId, session.id, {
    expectedVersion: session.toolPolicyVersion,
    agent: {
      identity: agentIdentity({
        name: input.name,
        role: input.role,
        description: input.description,
      }),
      instructions: composeInstructions({
        role: input.role,
        customInstructions: input.customInstructions,
        blank: input.blank,
      }),
    },
  });
}

export type ProfileUpdate = {
  name?: string;
  icon?: string;
  description?: string;
  instructions?: string;
};

/** Applies an agent's own `geni-profile` block. */
export async function applyProfileUpdate(
  workspaceId: string,
  sessionId: string,
  update: ProfileUpdate,
) {
  const session = await api.getSession(workspaceId, sessionId);
  const metadata = simpleMetadata(session);
  if (metadata?.kind !== "agent") throw new Error("Not an agent chat");
  const role = metadata.role ?? "agent";
  const current = getProfile(sessionId);
  const name =
    role === "main"
      ? MAIN_AGENT_NAME
      : (clean(update.name, 40) ?? current?.name ?? session.title ?? "Agent");
  const description = clean(update.description, 160) ?? current?.description ?? null;
  const customInstructions =
    clean(update.instructions, 8000) ?? current?.customInstructions ?? null;
  await applyAgentConfig(workspaceId, session, {
    role,
    name,
    description,
    customInstructions,
    blank: false,
  });
  if (role !== "main" && name !== session.title) {
    await api.updateSession(workspaceId, sessionId, { title: name });
  }
  return upsertProfile(workspaceId, sessionId, {
    name,
    role,
    description,
    customInstructions,
    instructionsVersion: INSTRUCTIONS_VERSION,
    ...(isAgentIcon(update.icon) ? { icon: update.icon } : {}),
  });
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
