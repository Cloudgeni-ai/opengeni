import { describe, expect, test } from "bun:test";
import type { Session } from "@/types";

import {
  filterSessionsForBrowse,
  groupSessionsForBrowse,
  sessionCreatorLabel,
} from "./sessions-group";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function session(overrides: Partial<Session> & { id: string }): Session {
  const { id, ...rest } = overrides;
  return {
    status: "idle",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-14T10:00:00.000Z",
    pinned: false,
    createdBy: { kind: "subject", subjectId: "user:ada", label: "Ada Lovelace" },
    ...rest,
    id,
  } as Session;
}

describe("session browse projections", () => {
  test("filters the selected date field without confusing creation and activity", () => {
    const recentlyActive = session({ id: "recently-active" });
    const recentlyCreated = session({
      id: "recently-created",
      createdAt: "2026-08-14T09:00:00.000Z",
      updatedAt: "2026-08-14T09:00:00.000Z",
    });

    expect(
      filterSessionsForBrowse([recentlyActive, recentlyCreated], {
        creator: null,
        dateField: "created",
        dateRange: "today",
        now: NOW,
      }).map((item) => item.id),
    ).toEqual(["recently-created"]);
    expect(
      filterSessionsForBrowse([recentlyActive, recentlyCreated], {
        creator: null,
        dateField: "activity",
        dateRange: "today",
        now: NOW,
      }).map((item) => item.id),
    ).toEqual(["recently-active", "recently-created"]);
  });

  test("filters by the frozen creator identity and keeps display labels separate", () => {
    const ada = session({ id: "ada" });
    const opaqueSubject = session({
      id: "opaque-subject",
      createdBy: { kind: "subject", subjectId: "tenant:ada" },
    });
    const scheduler = session({
      id: "scheduler",
      createdBy: { kind: "service", subjectId: "service:scheduler" },
    });

    expect(
      filterSessionsForBrowse([ada, scheduler], {
        creator: "service:service:scheduler",
        dateField: "activity",
        dateRange: "any",
        now: NOW,
      }).map((item) => item.id),
    ).toEqual(["scheduler"]);
    expect(sessionCreatorLabel(opaqueSubject)).toBe("tenant:ada");
    expect(sessionCreatorLabel(scheduler)).toBe("Service · service:scheduler");
  });

  test("groups flat browse results by creator or created-date buckets", () => {
    const ada = session({ id: "ada" });
    const grace = session({
      id: "grace",
      createdAt: "2026-08-14T08:00:00.000Z",
      createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
    });

    expect(
      groupSessionsForBrowse([grace, ada], "creator", NOW).grouped.map((g) => g.label),
    ).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(
      groupSessionsForBrowse([grace, ada], "created", NOW).grouped.map((g) => g.label),
    ).toEqual(["Created today", "Created earlier"]);
  });
});
