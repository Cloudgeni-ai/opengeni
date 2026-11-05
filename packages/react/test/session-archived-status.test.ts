import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionListEntry } from "@opengeni/sdk";
import { SESSION_ARCHIVE_STOP_REASON } from "@opengeni/contracts/session-history";
import { chatComposerPlaceholder } from "../src/app/lib/failed-session-copy";
import { sessionTimelineEmptyStateCopy } from "../src/app/lib/session-empty-state";
import { sessionHoverFacts } from "../src/app/lib/session-hover-facts";
import { sessionStateLabel } from "../src/app/lib/session-rail";
import { createOpenGeniText } from "../src/messages/runtime";
import { recentSessionStatus } from "../src/session-list-model";
import {
  SESSION_STATUS_BADGE,
  SESSION_STATUS_PRESENTATION,
  sessionArchived,
  sessionDisplayStatus,
  sessionStatusChangeIsArchive,
} from "../src/session-status-model";
import { buildTimeline } from "../src/timeline/projection";
import type { SessionStatusItem } from "../src/timeline/types";

const englishText = createOpenGeniText();

const activeControl: SessionListEntry["effectiveControl"] = {
  state: "active",
  controlVersion: 1,
  controlEtag: "etag",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

const pausedControl: SessionListEntry["effectiveControl"] = {
  ...activeControl,
  state: "paused",
  directState: "paused",
};

function row(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-0000000000aa",
    accountId: "00000000-0000-4000-8000-0000000000bb",
    status: "idle",
    title: "Release notes",
    titleSource: "agent",
    displayTitle: "Release notes",
    renameSeed: "Release notes",
    scheduledTaskId: null,
    siteOrigin: null,
    channelId: null,
    parentSessionId: null,
    rootSessionId: "00000000-0000-4000-8000-000000000001",
    effectiveControl: activeControl,
    lastSequence: 10,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    unread: false,
    activelyWorking: false,
    attentionVersion: 0,
    archived: false,
    archivedAt: null,
    archiveVersion: 0,
    createdAt: "2026-11-05T07:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
    ...overrides,
  } as SessionListEntry;
}

/** A running chat someone archived: its work was cancelled, which also paused it. */
const archivedWhileRunning = row({
  status: "cancelled",
  archived: true,
  archivedAt: "2026-11-05T08:00:00.000Z",
  effectiveControl: pausedControl,
});

/** An idle chat the deployment moved to long-term storage. */
const storedWhileIdle = row({
  retention: {
    keepLive: false,
    archive: { state: "archived", archivedAt: "2026-11-05T08:00:00.000Z" },
  },
});

function event(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `archived-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId: "turn-1",
    occurredAt: new Date(Date.UTC(2026, 10, 5) + sequence * 1000).toISOString(),
  } as SessionEvent;
}

describe("archived chats", () => {
  test("read as Archived whatever their last run state, never Cancelled", () => {
    for (const session of [archivedWhileRunning, storedWhileIdle]) {
      expect(sessionArchived(session)).toBe(true);
      expect(sessionDisplayStatus(session)).toBe("archived");
    }
    expect(
      sessionDisplayStatus({
        status: "requires_action",
        admissionBlock: { reason: "database_claim_rejected" },
        archived: true,
      }),
    ).toBe("archived");
    const presentation = SESSION_STATUS_PRESENTATION(englishText).archived;
    expect(presentation).toEqual({ label: "Archived", tone: "cancelled", pulse: false });
    expect(SESSION_STATUS_BADGE.archived).toEqual(SESSION_STATUS_BADGE.cancelled);
    expect(recentSessionStatus(archivedWhileRunning)).toEqual({ tone: "cancelled", pulse: false });
  });

  test("a live chat, or one cancelled without an archive, keeps its own status", () => {
    expect(sessionArchived(row())).toBe(false);
    expect(sessionDisplayStatus(row({ retention: { keepLive: true, archive: null } }))).toBe(
      "idle",
    );
    expect(sessionDisplayStatus(row({ status: "cancelled" }))).toBe("cancelled");
  });

  test("the sidebar row and its hover card name the archive, not a cancel or a pause", () => {
    expect(sessionStateLabel(archivedWhileRunning)).toBe("Archived");
    expect(sessionStateLabel(storedWhileIdle)).toBe("Archived");
    for (const session of [archivedWhileRunning, storedWhileIdle]) {
      const facts = sessionHoverFacts(session, {
        descendantCount: 0,
        descendantCountTruncated: false,
      });
      expect(facts.status).toEqual({ label: "Archived", tone: "neutral", live: false });
      expect(JSON.stringify(facts)).not.toMatch(/cancel|paused/i);
    }
    // A chat cancelled outside an archive still says so.
    expect(sessionStateLabel(row({ status: "cancelled", effectiveControl: pausedControl }))).toBe(
      "Cancelled · Paused here",
    );
  });

  test("the timeline divider of an archive reads archived", () => {
    const archive = { status: "cancelled", reason: SESSION_ARCHIVE_STOP_REASON };
    expect(sessionStatusChangeIsArchive(archive)).toBe(true);
    expect(sessionStatusChangeIsArchive({ status: "cancelled", reason: "session_cancelled" })).toBe(
      false,
    );
    const dividers = buildTimeline(englishText, [
      event(1, "session.status.changed", { status: "running" }),
      event(2, "session.status.changed", archive),
    ]).filter((item): item is SessionStatusItem => item.kind === "session-status");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ status: "cancelled", archived: true });

    const cancelled = buildTimeline(englishText, [
      event(1, "session.status.changed", { status: "cancelled", reason: "session_cancelled" }),
    ]).filter((item): item is SessionStatusItem => item.kind === "session-status");
    expect(cancelled[0]?.archived).toBeUndefined();
  });

  test("an empty archived chat and its read-only composer say it is archived", () => {
    expect(sessionTimelineEmptyStateCopy("archived", false).title).toBe("This chat is archived");
    expect(
      chatComposerPlaceholder({
        archived: true,
        cancelled: false,
        creditStopped: false,
        stopRefusal: null,
        creditGap: null,
        canBuyCredits: false,
      }),
    ).toBe("This chat is archived.");
  });
});
