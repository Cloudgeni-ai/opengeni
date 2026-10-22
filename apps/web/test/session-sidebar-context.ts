// Preview-only data/context wiring. SessionList, its hooks, and its styles are real.
import type {
  OpenGeniClient,
  SessionListPageOptions,
  SiteConversationGroup,
  WorkspaceLiveStreamOptions,
  WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { sessionListEntry } from "@opengeni/sdk/session-list-entries";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { SessionChannelProjectionAuthority } from "@opengeni/react/app/lib/session-pins";
import type { Session } from "@opengeni/react/app/types";
import { siteViewPreviewClient } from "./site-view-preview-client";

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

const siteConversationId = (number: number) =>
  `00000000-0000-4000-9000-${String(number).padStart(12, "0")}`;
const usageSiteHtml = `<!doctype html><html><head><style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e6e5e1;--bar:#4c6fff;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#18181a;--fg:#ededec;--muted:#9b9b97;--line:#2c2c2f;--bar:#7f98ff;--card:#202023}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{padding:28px 32px;max-width:980px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}p{margin:0;color:var(--muted)}
.range{display:flex;gap:6px;margin:18px 0 22px}.range span{border:1px solid var(--line);border-radius:999px;padding:3px 12px;font-size:12px;color:var(--muted)}
.range .on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card b{display:block;font-size:22px;margin:2px 0 12px}.label{font-size:12px;color:var(--muted)}
.bars{display:flex;align-items:flex-end;gap:5px;height:84px}.bars i{flex:1;background:var(--bar);border-radius:3px 3px 0 0;opacity:.85}
</style></head><body><main><h1>Opengeni usage</h1><p>Workspace activity across the organization</p>
<div class="range"><span>7 days</span><span class="on">30 days</span><span>90 days</span></div>
<div class="grid">
<div class="card"><span class="label">Weekly active users</span><b>831</b><div class="bars">${[38, 44, 41, 52, 49, 58, 61, 57, 66, 72, 70, 78].map((h) => `<i style="height:${h}%"></i>`).join("")}</div></div>
<div class="card"><span class="label">Sessions</span><b>12,408</b><div class="bars">${[50, 47, 55, 61, 58, 64, 60, 69, 74, 71, 80, 84].map((h) => `<i style="height:${h}%"></i>`).join("")}</div></div>
<div class="card"><span class="label">Tokens</span><b>1.9B</b><div class="bars">${[30, 36, 33, 45, 51, 48, 56, 62, 59, 64, 69, 75].map((h) => `<i style="height:${h}%"></i>`).join("")}</div></div>
<div class="card"><span class="label">Spend</span><b>$18,240</b><div class="bars">${[42, 40, 46, 49, 55, 53, 58, 63, 60, 67, 71, 73].map((h) => `<i style="height:${h}%"></i>`).join("")}</div></div>
</div></main></body></html>`;

/** Conversations that run inside a Site; ordinary pages leave them out. */
const siteConversationIds = new Set<string>();
export const usageSiteId = "00000000-0000-4000-a000-000000000001";
export const ipoSiteId = "00000000-0000-4000-a000-000000000002";
export const pricingSiteId = "00000000-0000-4000-a000-000000000003";
export const checklistSiteId = "00000000-0000-4000-a000-000000000004";
/**
 * Sites a listed chat created that have no conversations yet. Each sits in
 * its creating chat's project, ordered by its own latest activity.
 */
const createdSites: Array<{
  siteId: string;
  title: string;
  channelId: string | null;
  updatedAt: string;
}> = [];
/** This person's latest open of each Site, which counts as its activity. */
const siteOpenedAt = new Map<string, string>();
if (previewParameters.get("scenario") === "sites") {
  const siteConversation = (
    number: number,
    title: string,
    site: { siteId: string; title: string },
    channelId: string | null,
    age: number,
  ): Session => {
    const row = { ...session(number, title, channelId, age), metadata: {} } as Session;
    row.metadata = { _opengeniSiteOrigin: site };
    siteConversationIds.add(row.id);
    return row;
  };
  const usage = { siteId: usageSiteId, title: "Opengeni usage" };
  const ipo = { siteId: ipoSiteId, title: "IPO research dashboard" };
  rows.splice(
    0,
    rows.length,
    session(1, "Slack community connection test", null, 60),
    session(2, "Paused Slack QA schedule", null, 120),
    session(3, "Frequent external Opengeni users", null, 1380),
    session(4, "Gmail demo draft summary", null, 1500),
    session(5, "Workspace Site planning", null, 2900),
    session(6, "Homepage hero refresh", redesignId, 30),
    session(7, "Pricing page copy", redesignId, 400),
    session(8, "Flaky checkout test", bugfixesId, 200),
    siteConversation(901, "Time filters across all graphs", usage, null, 2),
    siteConversation(902, "Weekly active users by plan", usage, null, 180),
    siteConversation(903, "Export usage to CSV", usage, null, 2600),
    siteConversation(904, "Compare IPO filings", ipo, redesignId, 44),
  );
  // "Pricing page copy" (Website redesign) and "Workspace Site planning"
  // (Default) each made a Site nobody has asked anything yet.
  createdSites.push(
    {
      siteId: pricingSiteId,
      title: "Pricing calculator",
      channelId: redesignId,
      updatedAt: timeBefore(390),
    },
    {
      siteId: checklistSiteId,
      title: "Launch checklist",
      channelId: null,
      updatedAt: timeBefore(2880),
    },
  );
}

if (previewParameters.get("scenario") === "hover") {
  // Sample data for the sidebar hover preview. Every fact below is a field the
  // real compact list row carries; the values are illustrative.
  const activeControl = {
    state: "active",
    controlVersion: 1,
    controlEtag: "preview",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  };
  const stats = (overrides: Record<string, number | boolean> = {}) => ({
    directChildren: 0,
    totalDescendants: 0,
    runningDescendants: 0,
    queuedDescendants: 0,
    waitingDescendants: 0,
    attentionDescendants: 0,
    pausedDescendants: 0,
    failedDescendants: 0,
    unreadDescendants: 0,
    unreadFailedDescendants: 0,
    truncated: false,
    ...overrides,
  });
  const hoverRow = (
    number: number,
    title: string,
    age: number,
    overrides: Partial<Session> & Record<string, unknown>,
    createdBy: Session["createdBy"] = alex,
  ): Session =>
    ({
      ...session(number, title, null, age, createdBy),
      effectiveControl: activeControl,
      treeStats: stats(),
      ...overrides,
    }) as Session;
  const working = hoverRow(3001, "Astra strategy takeover - preserve and improve Grocery Bot", 2, {
    status: "running",
    model: "codex/gpt-6-astra",
    reasoningEffort: "max",
    backgroundCommandActivity: { state: "running", count: 2 },
    treeStats: stats({
      directChildren: 5,
      totalDescendants: 5,
      runningDescendants: 2,
      attentionDescendants: 1,
      pausedDescendants: 1,
      failedDescendants: 1,
      unreadFailedDescendants: 1,
    }),
  });
  const needsYou = hoverRow(3002, "Approve the staging database migration", 6, {
    status: "requires_action",
    requiresActionSince: timeBefore(24),
    model: "organization-claude-subscription/claude-opus-5-5",
    reasoningEffort: "high",
  });
  const waiting = hoverRow(3003, "Watch the nightly import and verify row counts", 9, {
    status: "idle",
    inputWait: {
      deadlineAt: new Date(now + 35 * 60_000).toISOString(),
      reason: "Waiting for the nightly import to finish before checking the row counts.",
    },
    model: "codex/gpt-6.1-sol",
    reasoningEffort: "xhigh",
  });
  const parent = hoverRow(3004, "Grocery Bot setup", 14, {
    status: "idle",
    model: "codex/gpt-6-astra",
    reasoningEffort: "high",
    effectiveControl: {
      ...activeControl,
      state: "paused",
      directState: "paused",
      primaryBlocker: {
        kind: "session",
        sessionId: "00000000-0000-4000-9000-000000003004",
        displayName: "Grocery Bot setup",
        actor: "Alex Morgan",
        reason: "Holding until the store API key is rotated.",
        changedAt: timeBefore(12),
        revision: 1,
      },
    },
    treeStats: stats({ directChildren: 1, totalDescendants: 1, pausedDescendants: 1 }),
  });
  const pausedChild = hoverRow(3005, "Compare grocery prices across three stores", 13, {
    status: "idle",
    parentSessionId: parent.id,
    rootSessionId: parent.id,
    model: "codex/gpt-6-astra",
    reasoningEffort: "medium",
    effectiveControl: {
      ...activeControl,
      state: "paused",
      directState: "active",
      primaryBlocker: parent.effectiveControl.primaryBlocker,
    },
  });
  const finished = hoverRow(
    3006,
    "Quarterly cloud cost report",
    48,
    {
      status: "idle",
      unread: true,
      hasSchedules: true,
      hasUpcomingSchedules: true,
      model: "codex/gpt-6-astra",
      reasoningEffort: "medium",
    },
    jamie,
  );
  // Targeted only by a paused or already-past one-time schedule: no clock icon.
  const lapsedSchedule = hoverRow(3007, "Release stabilization checkpoint", 300, {
    status: "idle",
    hasSchedules: true,
    hasUpcomingSchedules: false,
    model: "codex/gpt-6-astra",
    reasoningEffort: "high",
  });
  rows.splice(
    0,
    rows.length,
    working,
    needsYou,
    waiting,
    parent,
    pausedChild,
    finished,
    lapsedSchedule,
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
  /** Sites this person opened, in order. */
  siteOpens: string[];
  failChannelId: string | null;
  failCursor: string | null;
  failTodayCursor: string | null;
  holdTodayCursor: string | null;
  holdChannelId: string | null;
  holdChannelCursor: string | null;
  heldPageStarted: boolean;
  releaseHeldPage: () => void;
  /** `?hints=1` only: another device archives a row and the server sends its commit hint. */
  archiveRemotely: (sessionId: string) => void;
  snapshot: () => Session[];
};

export const evidence: SessionSidebarEvidence = {
  listCalls: [],
  archiveCalls: [],
  siteOpens: [],
  failChannelId: previewParameters.get("fail") === "bugfixes" ? bugfixesId : null,
  failCursor: null,
  failTodayCursor: null,
  holdTodayCursor: null,
  holdChannelId: null,
  holdChannelCursor: null,
  heldPageStarted: false,
  releaseHeldPage: () => {},
  archiveRemotely: (sessionId) => {
    const row = rows.find((candidate) => candidate.id === sessionId);
    if (!row) throw new Error("Preview session not found");
    row.archived = true;
    row.archivedAt = new Date().toISOString();
    row.archiveVersion = (row.archiveVersion ?? 0) + 1;
    row.updatedAt = row.archivedAt;
    publishHint([sessionId]);
  },
  snapshot: () => structuredClone(rows),
};

function filteredRows(options: SessionListPageOptions): Session[] {
  const archiveStatus = options.archiveStatus ?? (options.archivedOnly ? "archived" : "active");
  const selected = rows.filter((row) => {
    if (archiveStatus !== "all" && row.archived !== (archiveStatus === "archived")) return false;
    if (options.archivedOnly && !row.archived) return false;
    // Matches the server: Site conversations only for a Site filter or `include`.
    if (options.originSiteId) {
      if (
        !siteConversationIds.has(row.id) ||
        (row.metadata._opengeniSiteOrigin as { siteId?: string } | undefined)?.siteId !==
          options.originSiteId
      )
        return false;
    } else if (siteConversationIds.has(row.id) && options.siteConversations !== "include")
      return false;
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

/** The server's complete Site rows for a grouped root page. */
function previewSiteGroups(options: SessionListPageOptions): SiteConversationGroup[] {
  const groups = new Map<string, SiteConversationGroup>();
  for (const row of filteredRows({ ...options, siteConversations: "include" })) {
    if (!siteConversationIds.has(row.id)) continue;
    const origin = row.metadata._opengeniSiteOrigin as { siteId: string; title: string };
    const key = `${origin.siteId}:${row.channelId ?? ""}`;
    const current = groups.get(key);
    const active = row.status === "running" ? 1 : 0;
    if (current) {
      current.conversations += 1;
      current.total += 1;
      current.active += active;
      if (row.updatedAt > current.updatedAt) current.updatedAt = row.updatedAt;
      if (row.createdAt > current.createdAt) current.createdAt = row.createdAt;
      continue;
    }
    groups.set(key, {
      siteId: origin.siteId,
      channelId: row.channelId ?? null,
      title: origin.title,
      conversations: 1,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      total: 1,
      attention: 0,
      attentionSince: null,
      failed: 0,
      active,
      queued: 0,
      waiting: 0,
      unread: 0,
      activeWork: 0,
    });
  }
  const later = (a: string, b: string | undefined) => (b && b > a ? b : a);
  for (const group of groups.values())
    group.updatedAt = later(group.updatedAt, siteOpenedAt.get(group.siteId));
  const listed = new Set([...groups.values()].map((group) => group.siteId));
  if (!options.needsYouOnly && options.archiveStatus !== "archived")
    for (const created of createdSites) {
      if (listed.has(created.siteId)) continue;
      if (options.channelId !== undefined && options.channelId !== created.channelId) continue;
      groups.set(created.siteId, {
        siteId: created.siteId,
        channelId: created.channelId,
        title: created.title,
        conversations: 0,
        updatedAt: later(created.updatedAt, siteOpenedAt.get(created.siteId)),
        createdAt: created.updatedAt,
        total: 0,
        attention: 0,
        attentionSince: null,
        failed: 0,
        active: 0,
        queued: 0,
        waiting: 0,
        unread: 0,
        activeWork: 0,
      });
    }
  return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const heldChannelPage =
      evidence.holdChannelId !== null &&
      options.channelId === evidence.holdChannelId &&
      (options.cursor ?? null) === evidence.holdChannelCursor;
    if (
      heldChannelPage ||
      (todayPage && evidence.holdTodayCursor && options.cursor === evidence.holdTodayCursor)
    ) {
      evidence.holdTodayCursor = null;
      evidence.holdChannelId = null;
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
    return {
      sessions: structuredClone(page),
      pinned: [],
      nextCursor,
      filtersApplied: true,
      ...(options.siteConversations === "group" && options.cursor === undefined
        ? { siteConversations: "group" as const, siteGroups: previewSiteGroups(options) }
        : {}),
    };
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

// The Site view: each Site's page and its conversations' history.
if (previewParameters.get("scenario") === "sites") {
  Object.assign(
    client,
    siteViewPreviewClient({
      workspaceId,
      rows,
      sites: [
        { id: usageSiteId, title: "Opengeni usage", html: usageSiteHtml },
        { id: ipoSiteId, title: "IPO research dashboard", html: usageSiteHtml },
        { id: pricingSiteId, title: "Pricing calculator", html: usageSiteHtml },
        { id: checklistSiteId, title: "Launch checklist", html: usageSiteHtml },
      ],
      history: new Map([
        [
          siteConversationId(901),
          [
            [
              "Can the date range apply to every graph at once?",
              "Yes. The range picker at the top now filters all four graphs together: active users, sessions, tokens and spend. Each graph keeps its own zoom, and the range is kept in the address so a shared link opens the same view.",
            ],
          ],
        ],
        [
          siteConversationId(902),
          [
            [
              "Break weekly active users down by plan.",
              "Weekly active users last week: Team 412, Pro 268, Free 151. Team grew 9% week over week; Free was flat.",
            ],
          ],
        ],
        [
          siteConversationId(903),
          [
            [
              "Export the usage table to CSV.",
              "The export has one row per workspace and week, with sessions, tokens and spend. Use **Download CSV** above the table.",
            ],
          ],
        ],
      ]),
    }),
    {
      recordSiteOpened: async (_workspace: string, siteId: string) => {
        const openedAt = new Date().toISOString();
        siteOpenedAt.set(siteId, openedAt);
        evidence.siteOpens.push(siteId);
        return { openedAt };
      },
      tools: {
        forWorkspace: () => ({
          $catalog: async () => ({ tools: [], revision: "preview" }),
        }),
      },
    },
  );
}

// `?hints=1` serves the workspace live stream, so the sidebar runs in commit
// hint mode: no list polling, and only a published hint invalidates rows.
const pendingHints: WorkspaceSessionListEvent[] = [];
let wakeHintStream = () => {};
function publishHint(sessionIds: string[] | null) {
  pendingHints.push({
    type: "workspace.sessions.changed",
    workspaceId,
    available: true,
    sessionIds,
  });
  wakeHintStream();
}
if (previewParameters.has("hints")) {
  Object.assign(client, {
    getClientConfig: async () => ({}),
    getWorkspace: async (id: string) => ({ id, inferenceControl: { revision: 0 } }),
    streamWorkspaceLiveEvents: async function* (
      workspace: string,
      options: WorkspaceLiveStreamOptions = {},
    ) {
      options.onStateChange?.("live");
      yield {
        type: "workspace.sessions.changed",
        workspaceId: workspace,
        available: true,
        sessionIds: null,
      } satisfies WorkspaceSessionListEvent;
      while (!options.signal?.aborted) {
        const hint = pendingHints.shift();
        if (hint) {
          yield hint;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeHintStream = resolve;
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  });
}

const invocation = { workspaceId };
const context = {
  client,
  // In the Sites scenario the session route supplies the open session, as in
  // the app; the rail injects it. Other scenarios keep no open session.
  get session() {
    if (previewParameters.get("scenario") !== "sites") return null;
    const id = /\/sessions\/([^/]+)/u.exec(window.location.pathname)?.[1];
    return (id && rows.find((row) => row.id === id)) || null;
  },
  accessContext: {
    subjectId,
    workspaceGrants: [{ workspaceId, permissions: ["sessions:create", "artifacts:read"] }],
  },
  sessionChannelProjectionAuthority: new SessionChannelProjectionAuthority(),
  clientConfig: {},
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
