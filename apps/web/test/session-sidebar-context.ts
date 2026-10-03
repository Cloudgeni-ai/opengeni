// Preview-only data/context wiring. SessionList, its hooks, and its styles are real.
import type { OpenGeniClient, SessionListPageOptions } from "@opengeni/sdk";
import { sessionListEntry } from "@opengeni/sdk/session-list-entries";
import type { AppContextValue } from "../src/context";
import { SessionChannelProjectionAuthority } from "../src/lib/session-pins";
import type { Session } from "../src/types";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const subjectId = "sidebar-preview";
export const redesignId = "00000000-0000-4000-8000-000000000001";
export const bugfixesId = "00000000-0000-4000-8000-000000000002";
const previewParameters = new URLSearchParams(window.location.search);
const now = Date.now();
const alex = { kind: "subject", subjectId, label: "Alex Morgan" } as const;
const jamie = { kind: "subject", subjectId: "jamie-preview", label: "Jamie Chen" } as const;
const timeBefore = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function session(
  number: number,
  title: string,
  channelId: string | null,
  age: number,
  createdBy: Session["createdBy"] = alex,
): Session {
  return {
    id: `00000000-0000-4000-9000-${String(number).padStart(12, "0")}`,
    workspaceId,
    title,
    metadata: {},
    channelId,
    parentSessionId: null,
    createdBy,
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
  } as Session;
}

// The first shared page has 49 Alex roots + exactly one Jamie root. Jamie's
// other 49 roots can only be discovered by an independent creator/group read.
const rows = [
  session(1, "Workspace planning", null, 1),
  ...Array.from({ length: 8 }, (_, index) =>
    session(index + 101, `Design conversation ${index + 1}`, redesignId, index + 10),
  ),
  ...Array.from({ length: 40 }, (_, index) =>
    session(index + 201, `Bugfix conversation ${index + 1}`, bugfixesId, index + 30),
  ),
  ...Array.from({ length: 50 }, (_, index) =>
    session(index + 301, `Research conversation ${index + 1}`, null, index + 200, jamie),
  ),
  ...[
    ["Archived design kickoff", redesignId],
    ["Archived bugfix review", bugfixesId],
    ["Archived workspace notes", null],
    ["Archived design handoff", redesignId],
    ["Archived incident follow-up", bugfixesId],
    ["Archived automation check", null],
  ].map(([title, channelId], index) => ({
    ...session(401 + index, title!, channelId ?? null, 600 - index * 10),
    archived: true,
    // Filing order deliberately differs from ordinary updatedAt order.
    archivedAt: timeBefore((index + 1) * 1440),
    archiveVersion: 1,
  })),
];

if (previewParameters.get("scenario") === "retry") {
  // Push both real projects entirely outside the shared discovery page. A
  // failed first project read must still leave its real folder's retry visible.
  rows.push(
    ...Array.from({ length: 55 }, (_, index) =>
      session(501 + index, `Recent workspace conversation ${index + 1}`, null, index / 100),
    ),
  );
}

if (previewParameters.get("scenario") === "archived-child") {
  const root = rows.find((row) => row.title === "Archived design kickoff")!;
  root.treeStats = {
    ...root.treeStats,
    directChildren: 1,
    totalDescendants: 1,
    truncated: false,
  } as Session["treeStats"];
  rows.push({
    ...session(801, "Archived design investigation", redesignId, 550, {
      kind: "service",
      subjectId: "design-review-worker",
      label: "Design review worker",
    }),
    parentSessionId: root.id,
    rootSessionId: root.id,
    archived: true,
    archivedAt: root.archivedAt,
    archiveVersion: root.archiveVersion,
  });
}

if (previewParameters.get("scenario") === "sparse-active") {
  // Four running roots in the shared page, then an empty page followed by
  // one, one, and two new running roots in successive server pages. A single
  // four-row disclosure must traverse all of those client-filtered pages.
  const runningIndices = new Set([0, 10, 20, 30, 110, 185, 201, 209]);
  const channels = [redesignId, bugfixesId, null];
  rows.splice(
    0,
    rows.length,
    ...Array.from(
      { length: 210 },
      (_, index): Session => ({
        ...session(
          1000 + index,
          `Sparse workstream ${index + 1}`,
          channels[index % 3] ?? null,
          index + 1,
        ),
        status: runningIndices.has(index) ? "running" : "idle",
      }),
    ),
  );
}

if (previewParameters.get("scenario") === "keyboard-focus") {
  // Match the real Today retry boundary: 100 disclosed roots, then a final
  // six-row page whose successful retry must not enlarge the visible window.
  rows.splice(
    0,
    rows.length,
    ...Array.from({ length: 106 }, (_, index) =>
      session(2000 + index, `Focus conversation ${index + 1}`, null, index / 100),
    ),
  );
}

type RecordedOptions = Omit<SessionListPageOptions, "signal">;
export type SessionSidebarEvidence = {
  listCalls: {
    workspaceId: string;
    options: RecordedOptions;
    returnedIds: string[];
    nextCursor: string | null;
    outcome: "success" | "error";
  }[];
  archiveCalls: {
    workspaceId: string;
    sessionId: string;
    archived: boolean;
    expectedVersion: number;
    previousChannelId: string | null;
    returnedChannelId: string | null;
  }[];
  failChannelId: string | null;
  failCursor: string | null;
  failTodayCursor: string | null;
  holdTodayCursor: string | null;
  heldPageStarted: boolean;
  releaseHeldPage: () => void;
  snapshot: () => Session[];
};

export const evidence: SessionSidebarEvidence = {
  listCalls: [],
  archiveCalls: [],
  failChannelId: previewParameters.get("fail") === "bugfixes" ? bugfixesId : null,
  failCursor: null,
  failTodayCursor: null,
  holdTodayCursor: null,
  heldPageStarted: false,
  releaseHeldPage: () => {},
  snapshot: () => structuredClone(rows),
};

function filteredRows(options: SessionListPageOptions): Session[] {
  const archiveStatus = options.archiveStatus ?? (options.archivedOnly ? "archived" : "active");
  const selected = rows.filter((row) => {
    if (archiveStatus !== "all" && row.archived !== (archiveStatus === "archived")) return false;
    if (options.archivedOnly && !row.archived) return false;
    if (options.parentSessionId !== undefined && row.parentSessionId !== options.parentSessionId)
      return false;
    if (options.channelId !== undefined && row.channelId !== options.channelId) return false;
    if (
      options.createdBy &&
      (row.createdBy.kind !== options.createdBy.kind ||
        row.createdBy.subjectId !== options.createdBy.subjectId)
    )
      return false;
    if (options.search && !row.title?.toLowerCase().includes(options.search.toLowerCase()))
      return false;
    if (options.updatedFrom && row.updatedAt < options.updatedFrom) return false;
    if (options.updatedBefore && row.updatedAt >= options.updatedBefore) return false;
    if (options.createdFrom && row.createdAt < options.createdFrom) return false;
    if (options.createdBefore && row.createdAt >= options.createdBefore) return false;
    return true;
  });
  return selected.sort((a, b) => {
    const order =
      archiveStatus === "archived"
        ? (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt)
        : options.sortBy === "name"
          ? (a.title ?? "").localeCompare(b.title ?? "")
          : options.sortBy === "createdAt"
            ? b.createdAt.localeCompare(a.createdAt)
            : b.updatedAt.localeCompare(a.updatedAt);
    return order || a.id.localeCompare(b.id);
  });
}

export const client = {
  getSession: async (_workspace: string, id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error("Preview session not found");
    return structuredClone(row);
  },
  streamEvents: async function* () {},
  getSessionLineage: async () => ({ ancestors: [], descendants: [] }),
  listChannels: async () =>
    [
      { id: redesignId, name: "Website redesign", position: 0 },
      { id: bugfixesId, name: "Bugfixes", position: 1 },
    ].map((project) => ({
      ...project,
      workspaceId,
      pinned: false,
      createdAt: timeBefore(1000),
      updatedAt: timeBefore(1000),
    })),
  listSessionPage: async (workspace: string, options: SessionListPageOptions = {}) => {
    const { signal: _signal, ...recordedOptions } = options;
    const call: SessionSidebarEvidence["listCalls"][number] = {
      workspaceId: workspace,
      options: structuredClone(recordedOptions),
      returnedIds: [],
      nextCursor: null,
      outcome: "success",
    };
    evidence.listCalls.push(call);
    const todayPage = options.updatedFrom !== undefined && options.updatedBefore === undefined;
    if (todayPage && evidence.holdTodayCursor && options.cursor === evidence.holdTodayCursor) {
      evidence.holdTodayCursor = null;
      evidence.heldPageStarted = true;
      await new Promise<void>((resolve) => {
        evidence.releaseHeldPage = resolve;
      });
      evidence.releaseHeldPage = () => {};
    }
    if (
      (evidence.failChannelId &&
        options.channelId === evidence.failChannelId &&
        (options.cursor ?? null) === evidence.failCursor) ||
      (todayPage && evidence.failTodayCursor && options.cursor === evidence.failTodayCursor)
    ) {
      evidence.failChannelId = null;
      evidence.failTodayCursor = null;
      call.outcome = "error";
      throw new Error("Preview project page failed once");
    }
    if (options.pinsOnly)
      return { sessions: [], pinned: [], nextCursor: null, filtersApplied: true };
    const selected = filteredRows(options);
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid preview cursor");
    const page = selected.slice(offset, offset + limit);
    const nextCursor = offset + limit < selected.length ? String(offset + limit) : null;
    call.returnedIds = page.map((row) => row.id);
    call.nextCursor = nextCursor;
    return { sessions: structuredClone(page), pinned: [], nextCursor, filtersApplied: true };
  },
  updateSessionArchive: async (
    workspace: string,
    id: string,
    request: { archived: boolean; expectedVersion: number },
  ) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error("Preview session not found");
    if (request.expectedVersion !== row.archiveVersion)
      throw new Error("Preview archive version changed");
    const previousChannelId = row.channelId ?? null;
    row.archived = request.archived;
    row.archivedAt = request.archived ? new Date().toISOString() : null;
    row.archiveVersion = (row.archiveVersion ?? 0) + 1;
    row.updatedAt = new Date().toISOString();
    evidence.archiveCalls.push({
      workspaceId: workspace,
      sessionId: id,
      ...request,
      previousChannelId,
      returnedChannelId: row.channelId ?? null,
    });
    return structuredClone(row);
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

const invocation = { workspaceId };
const context = {
  client,
  session: null,
  accessContext: { subjectId },
  sessionChannelProjectionAuthority: new SessionChannelProjectionAuthority(),
  captureWorkspaceInvocation: () => invocation,
  ownsWorkspaceInvocation: (_workspace: string, accepted: unknown) => accepted === invocation,
  setSession: () => {},
  resetSessionView: () => {},
} as unknown as AppContextValue;

export const useAppContext = () => context;
export const useRail = () => ({
  workspaceId,
  isMobile: window.innerWidth < 768,
  setDrawerOpen: () => {},
});

declare global {
  interface Window {
    sessionSidebarQa: SessionSidebarEvidence;
  }
}
