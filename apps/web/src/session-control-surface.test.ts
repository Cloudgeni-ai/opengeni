import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("session control surface architecture", () => {
  test("renders one queue above the compact goal and agents surfaces", async () => {
    const route = await source("routes/session.tsx");
    expect(route.match(/<QueueSurface\b/g)).toHaveLength(1);
    expect(route.indexOf("<QueueSurface")).toBeLessThan(route.indexOf("<GoalSurface"));
    expect(route.indexOf("<GoalSurface")).toBeLessThan(route.indexOf("<ComposerAgentsPill"));
  });

  test("has no second Agents home in the header or dock", async () => {
    const [header, lineage, route] = await Promise.all([
      source("components/rail/session-header.tsx"),
      source("components/session/subagents.tsx"),
      source("routes/session.tsx"),
    ]);
    expect(header).not.toContain("agentsSlot");
    expect(lineage).not.toContain("AgentsPanel");
    expect(route).not.toContain('id: "agents"');
  });

  test("announces pin results through an independent live region", async () => {
    const [header, list] = await Promise.all([
      source("components/rail/session-header.tsx"),
      source("components/rail/session-list.tsx"),
    ]);
    // A persistent description on the action button would replay the previous
    // pin/unpin result every time keyboard focus returns. The result belongs in
    // the polite live region only, so it is announced at mutation time.
    expect(header).toContain('aria-live="polite"');
    expect(header).not.toContain("aria-describedby");
    // The same visible result can occur after a retry. Both pin surfaces use a
    // helper that still changes the live-region text node for that retry.
    expect(header).toContain("pinLiveAnnouncement");
    expect(list).toContain("pinLiveAnnouncement");
  });

  test("keeps rail optimistic pin overrides out of the header projection", async () => {
    const list = await source("components/rail/session-list.tsx");
    expect(list).toContain("const serverSessions = useMemo");
    expect(list).toContain("const projected = serverSessions.find");
    expect(list).toContain("const paginationKey = sessionPageKey(rail.workspaceId, search);");
    expect(list).not.toContain("const paginationKey = `${sessionPageKey");
  });

  test("the retired client-side queue model is gone", async () => {
    expect(await Bun.file(`${import.meta.dir}/lib/queue.ts`).exists()).toBe(false);
  });
});
