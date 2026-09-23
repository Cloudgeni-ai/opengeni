import { describe, expect, test } from "bun:test";
import {
  compactSessionMcpListRow,
  compactSessionMcpPause,
  sessionMcpIncludesRelatedWork,
  type Session,
  type SessionMcpMonitoringSource,
  type SessionQueueSnapshot,
  type WorkDiscoveryProjection,
} from "@opengeni/contracts";
import type { listSessionDiscoverySummaries } from "@opengeni/db";
import {
  capSessionDiscoveryCompactPage,
  capSessionDiscoveryPage,
  decodeSessionDiscoveryCursor,
  encodeSessionDiscoveryCursor,
} from "../src/mcp/server";
import { boundSessionCompactDetailMcp } from "../src/mcp/session-view";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-05T01:00:00.123456Z";
type Page = Awaited<ReturnType<typeof listSessionDiscoverySummaries>>;
const noFacts: SessionMcpMonitoringSource = { goal: null, progress: null, wait: null };
const control = { state: "active" as const, primaryBlocker: null, additionalBlockerCount: 0 };
const relatedWork: WorkDiscoveryProjection = {
  claims: [],
  claimsTruncated: false,
  match: null,
  possibleOverlap: false,
  advisoryOnly: true,
  noAdditionalAccess: true,
};

function page(count = 1): Page {
  return {
    sessions: Array.from({ length: count }, (_, i) => ({
      id: uuid(i + 1),
      title: `Task ${i + 1}`,
      titleOriginalChars: 6,
      status: "idle",
      parentSessionId: null,
      rootSessionId: uuid(i + 1),
      nestedAgentDepth: 0,
      effectiveControl: control,
      goal: null,
      queuedPromptCount: 0,
      treeStats: {
        directChildren: 0,
        totalDescendants: 0,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
        truncated: false,
      },
      latestMessage: null,
      workDiscovery: { ...relatedWork, claims: [] },
      createdAt: at,
      updatedAt: at,
      sortAt: at,
      sortRank: null,
      sortRevision: "0",
    })),
    total: count,
    hasMore: false,
    nextCursor: null,
    orderBy: "createdAt",
    snapshotAt: at,
    snapshotRevision: "0",
    updatedAfter: null,
    updatedThrough: null,
    filterHash: null,
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const keys = (value: object) => Object.keys(value).sort();

describe("compact-by-default MCP allowlists and byte regressions", () => {
  test("a queued prompt without a claimable preview stays absent in compact and null in full", () => {
    const source = page();
    const queued = source.sessions[0]!;
    queued.queuedPromptCount = 1;
    queued.latestMessage = null;
    const compact = capSessionDiscoveryCompactPage(source, { includeLastMessage: true });
    expect(compact.sessions[0]).toMatchObject({ id: queued.id, queuedPromptCount: 1 });
    expect(compact.sessions[0]).not.toHaveProperty("latestMessage");
    const full = capSessionDiscoveryPage(source, true);
    expect(full.sessions[0]).toMatchObject({
      id: queued.id,
      queuedPromptCount: 1,
      latestMessage: null,
    });

    // Once the DB supplies an eligible preview, neither presentation drops it.
    queued.latestMessage = {
      type: "user.message",
      preview: "claimed prompt",
      previewOriginalChars: 14,
    };
    expect(
      capSessionDiscoveryCompactPage(source, { includeLastMessage: true }).sessions[0],
    ).toHaveProperty("latestMessage", { type: "user.message", preview: "claimed prompt" });
    expect(capSessionDiscoveryPage(source, true).sessions[0]!.latestMessage).toEqual({
      type: "user.message",
      preview: "claimed prompt",
      previewTruncated: false,
    });
  });

  test("ordinary list pages contain only actionable fields, at 1/20/100 rows", () => {
    const expectedBytes = new Map([
      [1, 221],
      [20, 3330],
      [100, 16452],
    ]);
    for (const count of [1, 20, 100]) {
      const source = page(count);
      const compact = capSessionDiscoveryCompactPage(source);
      expect(keys(compact)).toEqual(["nextCursor", "sessions", "total"]);
      expect(compact.nextCursor).toBeNull();
      expect(compact.sessions).toHaveLength(count);
      for (const row of compact.sessions) {
        expect(keys(row)).toEqual(["id", "status", "title", "updatedAt"]);
      }
      expect(bytes(compact)).toBeLessThan(65 + count * 180);
      expect(bytes(compact)).toBe(expectedBytes.get(count)!);
      expect(bytes(compact)).toBeLessThan(bytes(capSessionDiscoveryPage(source, false)) * 0.25);
      expect(capSessionDiscoveryCompactPage(source)).toEqual(compact);
    }
  });

  test("closed allowlist ignores new/diagnostic/configuration properties", () => {
    const source = {
      ...page().sessions[0]!,
      initialMessage: "PRIVATE PROMPT",
      metadata: { secret: "NO" },
      model: "NO",
      resources: ["NO"],
      instructions: "NO",
      arbitrary: "NO",
    };
    expect(keys(compactSessionMcpListRow(source))).toEqual(["id", "status", "title", "updatedAt"]);
    expect(JSON.stringify(compactSessionMcpListRow(source))).not.toContain("NO");
    expect(compactSessionMcpPause(control)).toBeUndefined();
  });

  test("active, paused and completed goals retain status; loss facts only accompany loss", () => {
    for (const status of ["active", "paused", "completed"] as const) {
      const source = page();
      source.sessions[0]!.goal = { status, text: "Ship", textOriginalChars: 4 };
      const row = capSessionDiscoveryCompactPage(source).sessions[0]!;
      expect(row.goal).toEqual({ status, summary: "Ship" });
    }
    const source = page();
    Object.assign(source.sessions[0]!, {
      title: "🙂".repeat(200),
      titleOriginalChars: 50_000,
      parentSessionId: uuid(99),
      goal: { status: "paused", text: "🙂".repeat(600), textOriginalChars: 30_000 },
      effectiveControl: {
        state: "paused",
        primaryBlocker: {
          kind: "session",
          sessionId: uuid(99),
          displayName: "🙂".repeat(200),
          displayNameOriginalChars: 90_000,
        },
        additionalBlockerCount: 3,
      },
    });
    const row = capSessionDiscoveryCompactPage(source).sessions[0]!;
    expect(row.titleTruncated).toBeTrue();
    expect(row.goal?.summaryTruncated).toBeTrue();
    expect(row.pause).toMatchObject({
      state: "paused",
      additionalBlockerCount: 3,
      source: { kind: "session", sessionId: uuid(99), displayNameTruncated: true },
    });
    expect(row.parentSessionId).toBe(uuid(99));
    expect(JSON.stringify(row)).not.toContain("�");
  });

  test("related-work evidence remains explicit and never grants authority", () => {
    expect(sessionMcpIncludesRelatedWork({})).toBeFalse();
    expect(sessionMcpIncludesRelatedWork({ query: "  " })).toBeFalse();
    expect(sessionMcpIncludesRelatedWork({ includeRelatedWork: true })).toBeTrue();
    expect(sessionMcpIncludesRelatedWork({ detail: "full" })).toBeTrue();
    expect(
      sessionMcpIncludesRelatedWork({ detail: "full", includeRelatedWork: false }),
    ).toBeFalse();
    expect(sessionMcpIncludesRelatedWork({ query: "work", includeRelatedWork: false })).toBeTrue();
    expect(
      sessionMcpIncludesRelatedWork({ subject: { namespace: "git" }, includeRelatedWork: false }),
    ).toBeTrue();
    expect(capSessionDiscoveryCompactPage(page()).sessions[0]).not.toHaveProperty("relatedWork");
    const row = capSessionDiscoveryCompactPage(page(), { includeRelatedWork: true }).sessions[0]!;
    expect(row.relatedWork).toEqual(relatedWork);
    expect(row.relatedWork?.advisoryOnly).toBeTrue();
    expect(row.relatedWork?.noAdditionalAccess).toBeTrue();
  });

  test("positive descendant attention and incomplete counts are never hidden behind an idle root", () => {
    const source = page();
    Object.assign(source.sessions[0]!.treeStats, {
      attentionDescendants: 2,
      failedDescendants: 1,
      truncated: true,
    });
    expect(capSessionDiscoveryCompactPage(source).sessions[0]!.attention).toEqual({
      requiresActionDescendants: 2,
      failedDescendants: 1,
      truncated: true,
    });
    Object.assign(source.sessions[0]!.treeStats, { attentionDescendants: 0, failedDescendants: 0 });
    expect(capSessionDiscoveryCompactPage(source).sessions[0]!.attention).toEqual({
      truncated: true,
    });
  });

  test("exact cursor state survives unchanged pages and byte-truncated edges for every order", () => {
    for (const orderBy of ["createdAt", "updatedAt", "relevance"] as const) {
      const source = page(20);
      Object.assign(source, {
        orderBy,
        snapshotRevision: orderBy === "createdAt" ? "0" : "999999999999999999",
        updatedAfter: orderBy === "updatedAt" ? "999999999999999000" : null,
        updatedThrough: orderBy === "updatedAt" ? "999999999999999999" : null,
        filterHash: orderBy === "relevance" ? "a".repeat(64) : null,
      });
      for (const row of source.sessions) {
        row.sortRevision = orderBy === "createdAt" ? "0" : "999999999999999100";
        row.sortRank = orderBy === "relevance" ? 2 : null;
      }
      const result = capSessionDiscoveryCompactPage(source, {}, 1_500);
      expect(result.responseTruncated).toBeTrue();
      expect(result.sessions.length).toBeGreaterThan(0);
      expect(result.sessions.length).toBeLessThan(20);
      expect(bytes(result)).toBeLessThanOrEqual(1_500);
      const last = source.sessions[result.sessions.length - 1]!;
      const cursor = decodeSessionDiscoveryCursor(result.nextCursor!);
      expect(cursor).toEqual({
        orderBy,
        id: last.id,
        sortAt: last.sortAt,
        sortRevision: last.sortRevision,
        sortRank: last.sortRank,
        snapshotAt: source.snapshotAt,
        snapshotRevision: source.snapshotRevision,
        updatedAfter: source.updatedAfter,
        filterHash: source.filterHash,
      });
      source.hasMore = true;
      source.nextCursor = cursor;
      expect(capSessionDiscoveryCompactPage(source).nextCursor).toBe(
        encodeSessionDiscoveryCursor(cursor),
      );
      if (orderBy === "updatedAt") expect(result.updatedThrough).toBe(source.updatedThrough);
      else expect(result).not.toHaveProperty("updatedThrough");
    }
    expect(() => capSessionDiscoveryCompactPage(page(), {}, 1)).toThrow("exceeds");
  });

  test("preview budgets retain Unicode and explicit drill-down, with queued counts but no unclaimed prompt", () => {
    const source = page(20);
    source.sessions.forEach((row) => {
      row.latestMessage = {
        type: "agent.message.completed",
        preview: "🙂".repeat(600),
        previewOriginalChars: 600,
      };
    });
    source.sessions[0]!.latestMessage = null;
    source.sessions[0]!.queuedPromptCount = 4;
    const result = capSessionDiscoveryCompactPage(source, { includeLastMessage: true });
    expect(result.sessions[0]).toHaveProperty("queuedPromptCount", 4);
    expect(result.sessions[0]).not.toHaveProperty("latestMessage");
    const previewRows = result.sessions.filter((row) => "latestMessage" in row);
    expect(previewRows.some((row) => "previewOmitted" in row.latestMessage)).toBeTrue();
    for (const row of previewRows) {
      if ("previewOmitted" in row.latestMessage) {
        expect(row.latestMessage.previewDrillDownInput).toMatchObject({
          sessionId: row.id,
          includeTypes: ["agent.message.completed"],
          direction: "before",
          limit: 1,
          mode: "monitoring",
          payloadMode: "summary",
        });
      }
    }
  });

  test("detail excludes all config and diagnostic containers, with an exact management allowlist", () => {
    const session = {
      ...page().sessions[0]!,
      lastSequence: 7,
      activeTurnId: null,
      metadata: { enormous: "x".repeat(100_000) },
      initialMessage: "PRIVATE",
      effectiveToolPolicy: { secret: "NO" },
    } as unknown as Session;
    const queue = {
      items: [],
      pendingInputs: [],
      stoppingPreviousAttempt: false,
    } as unknown as SessionQueueSnapshot;
    const result = boundSessionCompactDetailMcp(session, noFacts, queue);
    expect(keys(result)).toEqual(["id", "lastSequence", "queue", "status", "title", "updatedAt"]);
    expect(result.queue).toEqual({ queuedTurns: 0, pendingInputs: 0 });
    expect(bytes(result)).toBeLessThan(300);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result).not.toHaveProperty("projection");
  });

  test("detail preserves encoded-prefix loss without inventing an original character count", () => {
    const session = { ...page().sessions[0]!, lastSequence: 7 } as unknown as Session;
    const result = boundSessionCompactDetailMcp(
      session,
      {
        ...noFacts,
        progress: {
          sequence: 7,
          text: "🙂".repeat(600),
          originalChars: null,
          textTruncated: true,
          occurredAt: at,
        },
      },
      null,
    );
    expect(result.progress).toEqual({
      sequence: 7,
      text: "🙂".repeat(600),
      textTruncated: true,
      occurredAt: at,
    });
  });

  test("detail preserves completion evidence, pause rationale, stopping, wait and progress; never silently drops them", () => {
    const session = {
      ...page().sessions[0]!,
      lastSequence: 100,
      activeTurnId: uuid(2),
      effectiveControl: {
        state: "paused",
        primaryBlocker: { kind: "workspace", displayName: "Workspace", reason: "Budget review" },
        additionalBlockerCount: 2,
        settlement: {
          state: "stopping",
          attemptCount: 2,
          interruptionPendingCount: 1,
          quiescencePendingCount: 1,
        },
        backgroundCommandSettlement: { state: "stopping", commandCount: 3 },
      },
    } as unknown as Session;
    const monitoring: SessionMcpMonitoringSource = {
      goal: {
        status: "completed",
        text: "Ship",
        textOriginalChars: 4,
        evidence: "proof🙂".repeat(5000),
        evidenceOriginalChars: 30000,
        rationale: "blocked on approval",
        rationaleOriginalChars: 19,
        pausedReason: "user_pause",
        pausedReasonOriginalChars: 10,
      },
      progress: { sequence: 99, text: "Tests passed", originalChars: 12, occurredAt: at },
      wait: { reason: "Waiting for child", until: at },
    };
    const queue = {
      items: [{}],
      pendingInputs: [{}, {}],
      stoppingPreviousAttempt: true,
    } as unknown as SessionQueueSnapshot;
    const result = boundSessionCompactDetailMcp(session, monitoring, queue);
    expect(result.goal).toMatchObject({
      status: "completed",
      summary: "Ship",
      evidenceTruncated: true,
      rationale: "blocked on approval",
      pausedReason: "user_pause",
    });
    expect(result.goal?.evidence).toContain("chars truncated");
    expect(result.progress).toEqual({ sequence: 99, text: "Tests passed", occurredAt: at });
    expect(result.pause).toEqual({
      state: "paused",
      source: { kind: "workspace", displayName: "Workspace", reason: "Budget review" },
      additionalBlockerCount: 2,
    });
    expect(result.queue).toEqual({
      queuedTurns: 1,
      pendingInputs: 2,
      stoppingPreviousAttempt: true,
    });
    expect(result.wait).toEqual({ reason: "Waiting for child", until: at });
    expect(result.stopping).toEqual({ attempts: 2, backgroundCommands: 3 });
    expect(bytes(result)).toBeLessThan(12_000);
    expect(() => boundSessionCompactDetailMcp(session, monitoring, queue, 100)).toThrow("exceeds");
  });
});
