import { describe, expect, test } from "bun:test";
import type { SessionEvent, WorkspaceArtifact, WorkspaceArtifactListResponse } from "@opengeni/sdk";

import {
  collectRecentActiveSites,
  getSiteNavigationSnapshot,
  latestSiteMutationSequence,
  notifySiteNavigationChanged,
  subscribeSiteNavigation,
} from "./site-navigation";

function event(sequence: number, type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: "2026-09-03T00:00:00.000Z",
  };
}

function artifact(id: string, status: WorkspaceArtifact["status"]): WorkspaceArtifact {
  return {
    id,
    accountId: "account-1",
    workspaceId: "workspace-1",
    slug: id,
    title: id,
    description: null,
    status,
    currentVersion: null,
    createdBySubjectId: "subject-1",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function page(
  artifacts: WorkspaceArtifact[],
  nextCursor: string | null,
): WorkspaceArtifactListResponse {
  return { artifacts, nextCursor, truncated: nextCursor !== null };
}

describe("Site navigation refresh", () => {
  test("tracks settled first-party Site lifecycle calls", () => {
    expect(
      latestSiteMutationSequence([
        event(1, "agent.toolCall.created", { id: "ordinary", name: "exec_command" }),
        event(2, "agent.toolCall.output", { id: "ordinary", output: "ok" }),
        event(3, "agent.toolCall.created", {
          id: "create",
          name: "opengeni__artifacts_create",
        }),
        event(4, "agent.toolCall.output", { id: "create", output: "created" }),
        event(5, "agent.toolCall.created", { id: "publish", name: "artifacts_publish" }),
        event(6, "agent.toolCall.output", { id: "publish", output: "published" }),
        event(7, "agent.toolCall.created", {
          id: "archive",
          name: "opengeni__artifacts_archive",
        }),
        event(8, "agent.toolCall.output", { id: "archive", output: "archived" }),
        event(9, "agent.toolCall.created", { id: "restore", name: "artifacts_restore" }),
        event(10, "agent.toolCall.output", { id: "restore", output: "restored" }),
        event(11, "agent.toolCall.created", {
          id: "rollback",
          name: "opengeni__artifacts_rollback",
        }),
        event(12, "agent.toolCall.output", { id: "rollback", output: "rolled back" }),
      ]),
    ).toBe(12);
  });

  test("does not refresh for an unsettled Site call or unmatched output", () => {
    expect(
      latestSiteMutationSequence([
        event(1, "agent.toolCall.created", { id: "create", name: "artifacts_create" }),
        event(2, "agent.toolCall.output", { id: "different", output: "created" }),
      ]),
    ).toBe(0);
  });

  test("ignores similarly named external MCP lifecycle tools", () => {
    expect(
      latestSiteMutationSequence([
        event(1, "agent.toolCall.created", {
          id: "external",
          name: "external__artifacts_archive",
        }),
        event(2, "agent.toolCall.output", { id: "external", output: "not a Site receipt" }),
      ]),
    ).toBe(0);
  });

  test("pages past archived Sites until the visible active shortcuts are full", async () => {
    const cursors: Array<string | null> = [];
    const result = await collectRecentActiveSites(async (cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        return page([artifact("archived-1", "archived")], "next-page");
      }
      return page(
        [
          artifact("active-1", "active"),
          artifact("archived-2", "archived"),
          artifact("active-2", "active"),
        ],
        null,
      );
    }, 2);

    expect(cursors).toEqual([null, "next-page"]);
    expect(result.map((entry) => entry.id)).toEqual(["active-1", "active-2"]);
  });

  test("bounds defensive pagination when a server returns only archived Sites", async () => {
    let pages = 0;
    const result = await collectRecentActiveSites(async () => {
      pages += 1;
      return page([artifact(`archived-${pages}`, "archived")], `page-${pages}`);
    }, 1);

    expect(result).toEqual([]);
    expect(pages).toBe(10);
  });

  test("publishes direct Site mutations through one workspace navigation snapshot", () => {
    const before = getSiteNavigationSnapshot();
    let notifications = 0;
    const unsubscribe = subscribeSiteNavigation(() => {
      notifications += 1;
    });
    notifySiteNavigationChanged();
    unsubscribe();

    expect(getSiteNavigationSnapshot()).toBe(before + 1);
    expect(notifications).toBe(1);
  });
});
