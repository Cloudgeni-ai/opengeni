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

  test("the retired client-side queue model is gone", async () => {
    expect(await Bun.file(`${import.meta.dir}/lib/queue.ts`).exists()).toBe(false);
  });
});
