import { describe, expect, test } from "bun:test";

import { workspaceSectionForPath } from "./workspace-nav-data";

const label = (path: string) => workspaceSectionForPath(path, "w1")?.label ?? null;

describe("the rail section a page is in", () => {
  test("names a detail page by its section", () => {
    expect(label("/workspaces/w1/agents/a1")).toBe("Agents");
    expect(workspaceSectionForPath("/workspaces/w1/agents/a1", "w1")?.path).toBe(
      "/workspaces/w1/agents",
    );
  });

  test("routes kept under another path belong to their section", () => {
    expect(label("/workspaces/w1/sites/s1")).not.toBeNull();
    expect(label("/workspaces/w1/schedules")).not.toBeNull();
    expect(label("/workspaces/w1/memory")).not.toBeNull();
    expect(label("/workspaces/w1/sites/s1")).toBe(label("/workspaces/w1/artifacts"));
    expect(label("/workspaces/w1/schedules")).toBe(label("/workspaces/w1/automations"));
    expect(label("/workspaces/w1/memory")).toBe(label("/workspaces/w1/state"));
  });

  test("chats and other workspaces have no section", () => {
    expect(label("/workspaces/w1/sessions/s1")).toBeNull();
    expect(label("/workspaces/w2/agents")).toBeNull();
  });
});
