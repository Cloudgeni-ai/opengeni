import { describe, expect, test } from "bun:test";
import type { Session } from "@/types";

import { railRowCreator } from "./creator-initials";
import {
  buildPinnedRailSections,
  filterSessionsForBrowse,
  groupSessionsForBrowse,
  normalizeSessionBrowseCreator,
  projectRailSessions,
  sessionBrowseResultCount,
  sessionCreatorLabelMap,
  sessionCreatorLabel,
  sessionCreatorOptions,
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

  test("groups root browse results by creator or created-date buckets", () => {
    const ada = session({ id: "ada" });
    const grace = session({
      id: "grace",
      createdAt: "2026-08-14T08:00:00.000Z",
      createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
    });

    expect(
      groupSessionsForBrowse([grace, ada], "creator", { now: NOW }).grouped.map((g) => g.label),
    ).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(
      groupSessionsForBrowse([grace, ada], "created", { now: NOW }).grouped.map((g) => g.label),
    ).toEqual(["Created today", "Created earlier"]);
  });

  test("groups workstream roots while preserving their descendant hierarchy", () => {
    const manager = session({
      id: "manager",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
    });
    const worker = session({
      id: "worker",
      parentSessionId: manager.id,
      createdAt: "2026-08-14T09:00:00.000Z",
      updatedAt: "2026-08-14T11:00:00.000Z",
      createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
    });

    const byCreated = groupSessionsForBrowse([worker, manager], "created", { now: NOW });
    expect(byCreated.grouped.map((group) => group.label)).toEqual(["Created earlier"]);
    expect(byCreated.grouped[0]?.sessions.map((node) => node.session.id)).toEqual(["manager"]);
    expect(byCreated.grouped[0]?.sessions[0]?.children.map((node) => node.session.id)).toEqual([
      "worker",
    ]);

    const byCreator = groupSessionsForBrowse([worker, manager], "creator", { now: NOW });
    expect(byCreator.grouped.map((group) => group.label)).toEqual(["Ada Lovelace"]);
    expect(byCreator.grouped[0]?.sessions[0]?.children[0]?.session.id).toBe("worker");

    const withActiveWorker = groupSessionsForBrowse(
      [{ ...worker, status: "running" }, manager],
      "created",
      { now: NOW },
    );
    expect(withActiveWorker.running.map((node) => node.session.id)).toEqual(["manager"]);
    expect(withActiveWorker.running[0]?.children.map((node) => node.session.id)).toEqual([
      "worker",
    ]);
  });

  test("hierarchical filters keep complete matching workstreams instead of orphaning children", () => {
    const manager = session({ id: "manager" });
    const worker = session({
      id: "worker",
      parentSessionId: manager.id,
      createdAt: "2026-08-14T09:00:00.000Z",
      createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
    });

    const matchingWorkstream = filterSessionsForBrowse([manager, worker], {
      creator: "subject:user:ada",
      dateField: "activity",
      dateRange: "any",
      hierarchical: true,
      now: NOW,
    });
    expect(matchingWorkstream.map((item) => item.id)).toEqual(["manager", "worker"]);
    expect(sessionBrowseResultCount(matchingWorkstream, true)).toBe(1);
    expect(sessionBrowseResultCount(matchingWorkstream, false)).toBe(2);
    expect(
      filterSessionsForBrowse([manager, worker], {
        creator: "subject:user:grace",
        dateField: "activity",
        dateRange: "any",
        hierarchical: true,
        now: NOW,
      }),
    ).toEqual([]);
  });

  test("normalizes child-only creator selections when returning to hierarchical browse", () => {
    const manager = session({ id: "manager" });
    const worker = session({
      id: "worker",
      parentSessionId: manager.id,
      createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
    });
    const childCreator = "subject:user:grace";
    const searchLabels = sessionCreatorLabelMap([manager, worker]);
    const hierarchyLabels = sessionCreatorLabelMap([manager]);

    expect(normalizeSessionBrowseCreator(childCreator, searchLabels, false)).toBe(childCreator);
    expect(normalizeSessionBrowseCreator(childCreator, hierarchyLabels, true)).toBeNull();
    expect(normalizeSessionBrowseCreator("subject:user:ada", hierarchyLabels, true)).toBe(
      "subject:user:ada",
    );
  });

  test("disambiguates duplicate frozen creator labels with opaque identities", () => {
    const firstAlex = session({
      id: "first-alex",
      createdBy: { kind: "subject", subjectId: "tenant-a:alex", label: "Alex" },
    });
    const secondAlex = session({
      id: "second-alex",
      createdBy: { kind: "subject", subjectId: "tenant-b:alex", label: "Alex" },
    });

    expect(sessionCreatorOptions([firstAlex, secondAlex])).toEqual([
      { value: "subject:tenant-a:alex", label: "Alex · Subject · tenant-a:alex" },
      { value: "subject:tenant-b:alex", label: "Alex · Subject · tenant-b:alex" },
    ]);
    expect(
      groupSessionsForBrowse([firstAlex, secondAlex], "creator", { now: NOW }).grouped.map(
        (group) => ({
          key: group.group,
          label: group.label,
        }),
      ),
    ).toEqual([
      {
        key: "creator:subject:tenant-a:alex",
        label: "Alex · Subject · tenant-a:alex",
      },
      {
        key: "creator:subject:tenant-b:alex",
        label: "Alex · Subject · tenant-b:alex",
      },
    ]);
  });

  test("reuses complete creator labels after filtering and excluding pins", () => {
    const firstAlex = session({
      id: "first-alex",
      createdBy: { kind: "subject", subjectId: "tenant-a:alex", label: "Alex" },
    });
    const pinnedAlex = session({
      id: "pinned-alex",
      pinned: true,
      createdBy: { kind: "subject", subjectId: "tenant-b:alex", label: "Alex" },
    });
    const complete = [firstAlex, pinnedAlex];
    const creatorLabels = sessionCreatorLabelMap(complete);
    const groupedSubset = filterSessionsForBrowse(complete, {
      creator: "subject:tenant-a:alex",
      dateField: "activity",
      dateRange: "any",
      now: NOW,
    }).filter((candidate) => !candidate.pinned);

    expect(
      groupSessionsForBrowse(groupedSubset, "creator", { now: NOW, creatorLabels }).grouped.map(
        (group) => ({ key: group.group, label: group.label }),
      ),
    ).toEqual([
      {
        key: "creator:subject:tenant-a:alex",
        label: "Alex · Subject · tenant-a:alex",
      },
    ]);
  });
});

describe("flat rail projection", () => {
  const parent = session({ id: "manager" });
  const child = session({
    id: "worker",
    parentSessionId: "manager",
    createdBy: { kind: "subject", subjectId: "user:grace", label: "Grace Hopper" },
  });

  test("hierarchy mode keeps lineage exactly as the server sent it", () => {
    const rows = [parent, child];

    expect(projectRailSessions(rows, true)).toBe(rows);
    expect(projectRailSessions(rows, true)[1]!.parentSessionId).toBe("manager");
  });

  test("a flat projection makes every row top-level", () => {
    const projected = projectRailSessions([parent, child], false);

    expect(projected.map((row) => row.parentSessionId)).toEqual([null, null]);
    // The originals are untouched; only the render-time copy is flattened.
    expect(child.parentSessionId).toBe("manager");
  });

  test("browse grouping preserves lineage while search results stay top-level", () => {
    const grouped = groupSessionsForBrowse([parent, child], "created", { now: NOW });
    const searched = buildPinnedRailSections(projectRailSessions([parent, child], false));

    const groupedRows = [
      ...grouped.running,
      ...grouped.grouped.flatMap((bucket) => bucket.sessions),
    ];
    expect(groupedRows.map((node) => node.session.id)).toEqual(["manager"]);
    expect(groupedRows[0]?.children.map((node) => node.session.id)).toEqual(["worker"]);
    expect(railRowCreator(groupedRows[0]!.children[0]!.session)).toBeNull();

    const searchedRows = searched.ordinary.grouped.flatMap((bucket) => bucket.sessions);
    expect(searchedRows.map((node) => node.session.id).sort()).toEqual(["manager", "worker"]);
    for (const node of searched.ordinary.grouped.flatMap((bucket) => bucket.sessions)) {
      expect(railRowCreator(node.session)).not.toBeNull();
    }
  });
});
