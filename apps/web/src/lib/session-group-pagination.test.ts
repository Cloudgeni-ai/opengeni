import { describe, expect, test } from "bun:test";

import {
  sessionMatchesPaginationGroup,
  sessionPaginationGroupQuery,
  sessionPaginationLocalDateKey,
  type SessionPaginationBrowseFilter,
  type SessionPaginationGroup,
} from "./session-group-pagination";
import type { Session } from "@/types";

const NOW = new Date(2026, 8, 4, 12, 0, 0);
const BROWSE_ALL: SessionPaginationBrowseFilter = {
  creator: null,
  dateField: "activity",
  dateRange: "any",
};

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(2026, 8, 4, 9, 0, 0).toISOString(),
    updatedAt: new Date(2026, 8, 4, 10, 0, 0).toISOString(),
    channelId: null,
    status: "idle",
    effectiveControl: { state: "active" },
    createdBy: { kind: "subject", subjectId: "user:ada" },
    ...overrides,
  } as Session;
}

describe("session group pagination", () => {
  test("builds exact project and creator filters", () => {
    const channel: SessionPaginationGroup = {
      key: "channel:one",
      label: "Project one",
      kind: "channel",
      channelId: "00000000-0000-4000-8000-000000000001",
    };
    expect(sessionPaginationGroupQuery(channel, BROWSE_ALL, NOW)).toEqual({
      channelId: channel.channelId,
    });

    const creator: SessionPaginationGroup = {
      key: "creator:ada",
      label: "Ada",
      kind: "creator",
      creator: { kind: "subject", subjectId: "tenant:ada" },
    };
    expect(sessionPaginationGroupQuery(creator, BROWSE_ALL, NOW)).toEqual({
      createdBy: creator.creator,
    });
  });

  test("intersects a created-date bucket with the active browse range", () => {
    const group: SessionPaginationGroup = {
      key: "created:yesterday",
      label: "Created yesterday",
      kind: "created",
      group: "yesterday",
    };
    expect(
      sessionPaginationGroupQuery(
        group,
        { creator: null, dateField: "created", dateRange: "week" },
        NOW,
      ),
    ).toEqual({
      createdFrom: new Date(2026, 8, 3).toISOString(),
      createdBefore: new Date(2026, 8, 4).toISOString(),
    });
  });

  test("keeps the archived folder independent from active browse filters", () => {
    expect(
      sessionPaginationGroupQuery(
        { key: "archived", label: "Archived", kind: "archived" },
        {
          creator: { kind: "subject", subjectId: "user:ada" },
          dateField: "created",
          dateRange: "today",
        },
        NOW,
      ),
    ).toEqual({ archivedOnly: true });
  });

  test("rejects date groups outside the active browse window before transport", () => {
    expect(
      sessionPaginationGroupQuery(
        { key: "activity:older", label: "Older", kind: "activity", group: "older" },
        { creator: null, dateField: "activity", dateRange: "week" },
        NOW,
      ),
    ).toBeNull();
  });

  test("matches active, recency, creator, and channel groups independently", () => {
    const active = row({ status: "running" });
    const yesterday = row({ updatedAt: new Date(2026, 8, 3, 12).toISOString() });
    const ada = row();
    const channel = row({ channelId: "00000000-0000-4000-8000-000000000002" });

    expect(
      sessionMatchesPaginationGroup(
        active,
        { key: "active", label: "Active", kind: "activity", group: "active" },
        NOW,
      ),
    ).toBe(true);
    expect(
      sessionMatchesPaginationGroup(
        yesterday,
        { key: "yesterday", label: "Yesterday", kind: "activity", group: "yesterday" },
        NOW,
      ),
    ).toBe(true);
    expect(
      sessionMatchesPaginationGroup(
        ada,
        {
          key: "creator:ada",
          label: "Ada",
          kind: "creator",
          creator: { kind: "subject", subjectId: "user:ada" },
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      sessionMatchesPaginationGroup(
        channel,
        {
          key: "channel:two",
          label: "Project two",
          kind: "channel",
          channelId: channel.channelId,
        },
        NOW,
      ),
    ).toBe(true);
  });

  test("uses the browser-local calendar date in the continuation identity", () => {
    expect(sessionPaginationLocalDateKey(NOW)).toBe("2026-9-4");
  });
});
