import { SessionChannelProjectionAuthority } from "../src/lib/session-pins";
import type { AppContextValue } from "../src/context";
import type { OpenGeniClient } from "@opengeni/sdk";
import type { Session } from "../src/types";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
let project = {
  id: "project-qa",
  workspaceId,
  name: "Website redesign",
  pinned: false,
  position: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const otherProject = {
  ...project,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Bugfixes",
  position: 1,
};
function session(channelId: string | null, number: number, title: string): Session {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    workspaceId,
    title,
    channelId,
    parentSessionId: null,
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
    status: "idle",
    effectiveControl: { state: "active" },
    createdBy: { kind: "subject", subjectId: "rename-qa" },
    pinned: false,
    archived: false,
    unread: false,
  } as Session;
}
const defaultSessions = Array.from({ length: 65 }, (_, i) =>
  session(null, i + 1, `Default conversation ${i + 1}`),
);
const projectSessions = [
  session(project.id, 101, "Website redesign kickoff"),
  session(project.id, 102, "Website redesign review"),
];
const bugfixSessions = Array.from({ length: 55 }, (_, i) =>
  session(otherProject.id, i + 201, `Bugfix conversation ${i + 1}`),
);
export const evidence = {
  calls: [] as unknown[],
  pageCalls: [] as unknown[],
  fail: false,
  delay: 0,
};
export const client = {
  getSession: async () => null,
  streamEvents: async function* () {},
  getSessionLineage: async () => ({ ancestors: [], descendants: [] }),
  listChannels: async () => [{ ...project }, otherProject],
  listSessionPage: async (
    _workspace: string,
    options: {
      channelId?: string | null;
      cursor?: string;
      limit?: number;
      pinsOnly?: boolean;
    } = {},
  ) => {
    if (options.pinsOnly) return { sessions: [], pinned: [], nextCursor: null };
    evidence.pageCalls.push({
      channelId: options.channelId,
      cursor: options.cursor,
      limit: options.limit,
    });
    const rows =
      options.channelId === undefined
        ? [...defaultSessions, ...projectSessions, ...bugfixSessions]
        : options.channelId === null
          ? defaultSessions
          : options.channelId === project.id
            ? projectSessions
            : bugfixSessions;
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 50;
    return {
      sessions: rows.slice(offset, offset + limit),
      pinned: [],
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  },
  updateChannel: async (workspace: string, id: string, request: { name: string }) => {
    evidence.calls.push({ workspace, id, request });
    if (evidence.delay) await new Promise((resolve) => setTimeout(resolve, evidence.delay));
    if (evidence.fail) throw new Error("A project with this name already exists");
    project = { ...project, ...request };
    return { ...project };
  },
} as unknown as OpenGeniClient;
const context = {
  client,
  session: null,
  accessContext: { subjectId: "rename-qa" },
  sessionChannelProjectionAuthority: new SessionChannelProjectionAuthority(),
  setSession: () => {},
  resetSessionView: () => {},
} as unknown as AppContextValue;
export const useAppContext = () => context;
export const useRail = () => ({ workspaceId, setDrawerOpen: () => {} });
