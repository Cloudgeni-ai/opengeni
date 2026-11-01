// Preview-only data and context for project profiles. The rail, the project
// and chat profile dialogs, their hooks and styles are production UI; only
// the workspace's projects and chats are sample data.
import { useSyncExternalStore } from "react";
import type {
  Channel,
  OpenGeniClient,
  SessionListPageOptions,
  UpdateChannelRequest,
  UpdateSessionRequest,
} from "@opengeni/sdk";
import { sessionListEntry } from "@opengeni/sdk/session-list-entries";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { SessionChannelProjectionAuthority } from "@opengeni/react/app/lib/session-pins";
import type { Session } from "@opengeni/react/app/types";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const subjectId = "project-profile-preview";
export const RAIL_DEFAULT_WIDTH = 288;
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;

const now = Date.now();
const timeBefore = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const projectId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const uiUxId = projectId(1);
export const bugfixesId = projectId(2);
export const featuresId = projectId(3);
export const researchId = projectId(4);

function project(
  id: string,
  name: string,
  sortOrder: number,
  profile: Pick<Channel, "description" | "avatar">,
): Channel {
  return {
    id,
    accountId: "preview-org",
    workspaceId,
    name,
    pinned: false,
    sortOrder,
    createdBy: subjectId,
    createdAt: timeBefore(20_000),
    updatedAt: timeBefore(20_000),
    ...profile,
  };
}

let projects: Channel[] = [
  project(uiUxId, "UI/UX", 0, {
    description: "Interface polish, accessibility and design reviews.",
    avatar: { kind: "emoji", emoji: "🎨", hue: 305 },
  }),
  project(bugfixesId, "Bugfixes", 1, {
    description: "Customer-reported bugs and regressions until they ship.",
    avatar: { kind: "icon", icon: "bug", hue: 0 },
  }),
  project(featuresId, "Features", 2, {
    description: "New capabilities, from spec to merged pull request.",
    avatar: { kind: "icon", icon: "rocket", hue: 215 },
  }),
  // Described but without an avatar: it keeps the folder.
  project(researchId, "Research", 3, {
    description: "Spikes, benchmarks and reading notes.",
    avatar: null,
  }),
];

const alex = { kind: "subject", subjectId, label: "Alex Morgan" } as const;

function session(
  number: number,
  title: string,
  channelId: string | null,
  age: number,
  profile: Partial<Pick<Session, "description" | "avatar" | "status">> = {},
): Session {
  return {
    id: `00000000-0000-4000-9000-${String(number).padStart(12, "0")}`,
    workspaceId,
    title,
    titleSource: "user",
    metadata: {},
    channelId,
    parentSessionId: null,
    createdBy: alex,
    createdAt: timeBefore(age + 120),
    updatedAt: timeBefore(age),
    status: "idle",
    effectiveControl: { state: "active" },
    pinned: false,
    pinVersion: 0,
    archived: false,
    archivedAt: null,
    archiveVersion: 0,
    unread: false,
    treeStats: { directChildren: 0, totalDescendants: 0, truncated: false },
    ...profile,
  } as Session;
}

const rows: Session[] = [
  session(1, "Sidebar project icons", uiUxId, 2, { status: "running" }),
  session(2, "Design review bot", uiUxId, 45, {
    description: "Reviews UI pull requests against the design system.",
    avatar: { kind: "icon", icon: "pen-tool", hue: 305 },
  }),
  session(3, "Dark mode contrast audit", uiUxId, 300),
  session(11, "Triage bot", bugfixesId, 8, {
    description: "Files and labels incoming bug reports every morning.",
    avatar: { kind: "emoji", emoji: "🐛", hue: 130 },
  }),
  session(12, "Fix stuck uploads on Safari", bugfixesId, 25),
  session(13, "Slack thread replies arrive twice", bugfixesId, 190),
  session(21, "Project profiles", featuresId, 5, { status: "running" }),
  session(22, "Release notes writer", featuresId, 600, {
    description: "Drafts the weekly release notes from merged PRs.",
    avatar: { kind: "icon", icon: "file-text", hue: 55 },
  }),
  session(31, "Benchmark the new search ranking", researchId, 70),
  session(32, "Reading notes: agent memory", researchId, 1600),
  session(41, "Weekly planning", null, 15),
];

export const evidence = {
  channelUpdates: [] as { id: string; request: UpdateChannelRequest }[],
  sessionUpdates: [] as { id: string; request: UpdateSessionRequest }[],
};

function filteredRows(options: SessionListPageOptions): Session[] {
  return rows
    .filter((row) => {
      if (options.pinsOnly) return row.pinned;
      if (options.archivedOnly || options.archiveStatus === "archived") return false;
      if (options.parentSessionId !== undefined && row.parentSessionId !== options.parentSessionId)
        return false;
      if (options.channelId !== undefined && row.channelId !== options.channelId) return false;
      if (options.search && !row.title?.toLowerCase().includes(options.search.toLowerCase()))
        return false;
      if (options.updatedFrom && row.updatedAt < options.updatedFrom) return false;
      if (options.updatedBefore && row.updatedAt >= options.updatedBefore) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export const client = {
  getSession: async (_workspace: string, id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error("Preview session not found");
    return structuredClone(row);
  },
  streamEvents: async function* () {},
  getSessionLineage: async () => ({ ancestors: [], descendants: [] }),
  listChannels: async () => structuredClone(projects),
  updateChannel: async (_workspace: string, id: string, request: UpdateChannelRequest) => {
    evidence.channelUpdates.push({ id, request: structuredClone(request) });
    const current = projects.find((candidate) => candidate.id === id);
    if (!current) throw new Error("Preview project not found");
    if (
      request.name !== undefined &&
      projects.some(
        (other) => other.id !== id && other.name.toLowerCase() === request.name!.toLowerCase(),
      )
    ) {
      throw new Error("channel name is already in use");
    }
    const next: Channel = {
      ...current,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.avatar !== undefined ? { avatar: request.avatar } : {}),
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      updatedAt: new Date().toISOString(),
    };
    projects = projects.map((candidate) => (candidate.id === id ? next : candidate));
    return structuredClone(next);
  },
  listSessionPage: async (_workspace: string, options: SessionListPageOptions = {}) => {
    if (options.pinsOnly)
      return {
        sessions: [],
        pinned: filteredRows(options),
        nextCursor: null,
        filtersApplied: true,
      };
    const selected = filteredRows(options);
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 50;
    return {
      sessions: structuredClone(selected.slice(offset, offset + limit)),
      pinned: [],
      nextCursor: offset + limit < selected.length ? String(offset + limit) : null,
      filtersApplied: true,
    };
  },
} as unknown as OpenGeniClient;
client.listSessionSummaryPage = async (workspace, options) => {
  const page = await client.listSessionPage(workspace, options);
  return {
    ...page,
    projection: "summary",
    sessions: page.sessions.map(sessionListEntry),
    pinned: page.pinned.map(sessionListEntry),
  };
};

const workspace = {
  id: workspaceId,
  accountId: "preview-org",
  name: "cloudgeni",
  status: "active",
};
const invocation = { workspaceId };
const context = {
  client,
  session: null,
  clientConfig: { auth: { mode: "deploymentKey" }, connectedMachines: false },
  workspaces: [workspace],
  workspace,
  managedSelfContext: null,
  authSession: null,
  accessContext: {
    subjectId,
    subjectLabel: "Alex Morgan",
    workspaceGrants: [
      { workspaceId, permissions: ["sessions:read", "sessions:create", "sessions:control"] },
    ],
    accountGrants: [
      { accountId: "preview-org", permissions: [], metadata: { accountName: "Cloudgeni" } },
    ],
  },
  sessionChannelProjectionAuthority: new SessionChannelProjectionAuthority(),
  captureWorkspaceInvocation: () => invocation,
  ownsWorkspaceInvocation: (_workspace: string, accepted: unknown) => accepted === invocation,
  setSession: () => {},
  resetSessionView: () => {},
  updateSessionProfile: async (_workspace: string, id: string, request: UpdateSessionRequest) => {
    evidence.sessionUpdates.push({ id, request: structuredClone(request) });
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    Object.assign(row, request, { updatedAt: row.updatedAt });
    return structuredClone(row);
  },
} as unknown as AppContextValue;

export const useAppContext = () => context;
export const useOptionalAppContext = () => context;

let collapsed = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const setCollapsed = (value: boolean) => {
  collapsed = value;
  listeners.forEach((listener) => listener());
};
export function useRail() {
  return {
    workspaceId,
    collapsed: useSyncExternalStore(subscribe, () => collapsed),
    isMobile: false,
    drawerOpen: false,
    width: RAIL_DEFAULT_WIDTH,
    setCollapsed,
    toggleCollapsed: () => setCollapsed(!collapsed),
    setDrawerOpen: () => {},
    openWorkspace: () => {},
    openOrg: () => {},
    startNewSession: () => {},
  };
}
// The settings shell reads the rail where it may be absent; here it is present.
export const useOptionalRail = useRail;
