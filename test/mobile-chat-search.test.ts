import { describe, expect, test } from "bun:test";
import type { Session, Workspace } from "@opengeni/sdk";
import { rankChatSearch, workspacesToSearch } from "../apps/mobile/src/chat-search";

function workspace(id: string, name: string, accountId = "org-a"): Workspace {
  return { id, name, accountId, kind: "shared" } as unknown as Workspace;
}

function chat(id: string, title: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    title,
    parentSessionId: null,
    pinned: false,
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...extra,
  } as unknown as Session;
}

const HERE = workspace("w-here", "Product");
const SIBLING = workspace("w-sibling", "Design");
const OTHER_ORG = workspace("w-other", "Billing", "org-b");
const ALL = [OTHER_ORG, SIBLING, HERE];

describe("workspacesToSearch", () => {
  test("searches this workspace first, then its organization, then the others", () => {
    expect(workspacesToSearch("w-here", ALL)).toEqual(["w-here", "w-sibling", "w-other"]);
  });

  test("covers at most nine other workspaces", () => {
    const many = Array.from({ length: 14 }, (_, index) => workspace(`w-${index}`, `W${index}`));
    const searched = workspacesToSearch("w-0", many);
    expect(searched[0]).toBe("w-0");
    expect(searched).toHaveLength(10);
  });
});

describe("rankChatSearch", () => {
  test("finds chats in other workspaces, ranked just below an equal match here", () => {
    const result = rankChatSearch({
      query: "deploy",
      currentWorkspaceId: "w-here",
      local: [chat("a", "Deploy checklist")],
      remote: [
        { session: chat("b", "Deploy checklist"), workspaceId: "w-other", fromServer: true },
        { session: chat("c", "Weekly notes"), workspaceId: "w-sibling", fromServer: false },
      ],
      workspaces: ALL,
    });
    expect(result.chats.map((hit) => [hit.session.id, hit.workspaceId])).toEqual([
      ["a", "w-here"],
      ["b", "w-other"],
    ]);
  });

  test("lists matching workspaces to switch to, never the current one", () => {
    const result = rankChatSearch({
      query: "des",
      currentWorkspaceId: "w-here",
      local: [],
      remote: [],
      workspaces: ALL,
    });
    expect(result.workspaces.map((each) => each.id)).toEqual(["w-sibling"]);
    expect(
      rankChatSearch({
        query: "prod",
        currentWorkspaceId: "w-here",
        local: [],
        remote: [],
        workspaces: ALL,
      }).workspaces,
    ).toEqual([]);
  });

  test("keeps the server's first-message matches and drops sub-agent chats", () => {
    const result = rankChatSearch({
      query: "invoice",
      currentWorkspaceId: "w-here",
      local: [chat("child", "Invoice worker", { parentSessionId: "parent" } as Partial<Session>)],
      remote: [{ session: chat("d", "Untitled chat"), workspaceId: "w-other", fromServer: true }],
      workspaces: ALL,
    });
    expect(result.chats.map((hit) => hit.session.id)).toEqual(["d"]);
  });

  test("an empty query shows nothing", () => {
    expect(
      rankChatSearch({
        query: "  ",
        currentWorkspaceId: "w-here",
        local: [chat("a", "Anything")],
        remote: [],
        workspaces: ALL,
      }),
    ).toEqual({ chats: [], workspaces: [] });
  });
});
