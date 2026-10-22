import { describe, expect, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  loadWorkspaceBudgetRows,
  WORKSPACE_BUDGET_READ_CONCURRENCY,
  type WorkspaceBudgetRow,
} from "./workspace-budget-rows";

function fakeClient() {
  const paths: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    requestJson: async (_method: string, path: string) => {
      paths.push(path);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (path.endsWith("/allowance/state")) return { version: 0, config: null };
      return { workspace: { used: 0, limit: null, fraction: null, status: "ok" }, members: [] };
    },
  } as unknown as OpenGeniBrowserClient;
  return { client, paths, maxInFlight: () => maxInFlight };
}

describe("loadWorkspaceBudgetRows", () => {
  test("a 300-workspace organization reads with bounded concurrency", async () => {
    const fake = fakeClient();
    const ids = Array.from({ length: 300 }, (_, index) => `ws-${index}`);
    const rows = new Map<string, WorkspaceBudgetRow>();
    await loadWorkspaceBudgetRows({
      client: fake.client,
      workspaceIds: ids,
      canReadUsage: () => true,
      onRow: (id, row) => rows.set(id, row),
    });
    expect(rows.size).toBe(300);
    // Each in-flight workspace issues at most its two reads together.
    expect(fake.maxInFlight()).toBeLessThanOrEqual(WORKSPACE_BUDGET_READ_CONCURRENCY * 2);
  });

  test("own usage is requested only for workspaces the viewer belongs to", async () => {
    const fake = fakeClient();
    const rows = new Map<string, WorkspaceBudgetRow>();
    await loadWorkspaceBudgetRows({
      client: fake.client,
      workspaceIds: ["member", "outsider"],
      canReadUsage: (id) => id === "member",
      onRow: (id, row) => rows.set(id, row),
    });
    expect(fake.paths.filter((path) => path.endsWith("/usage/me"))).toEqual([
      "/v1/workspaces/member/usage/me",
    ]);
    expect(fake.paths.filter((path) => path.endsWith("/allowance/state"))).toHaveLength(2);
    expect(rows.get("member")?.usage).not.toBeNull();
    expect(rows.get("outsider")).toEqual({
      state: { version: 0, config: null },
      usage: null,
      unreadable: false,
    });
  });

  test("an unmounted section stops starting new reads", async () => {
    const fake = fakeClient();
    let active = true;
    const seen: string[] = [];
    await loadWorkspaceBudgetRows({
      client: fake.client,
      workspaceIds: Array.from({ length: 50 }, (_, index) => `ws-${index}`),
      canReadUsage: () => false,
      isActive: () => active,
      onRow: (id) => {
        seen.push(id);
        active = false;
      },
    });
    expect(seen).toHaveLength(1);
    expect(fake.paths.length).toBeLessThanOrEqual(WORKSPACE_BUDGET_READ_CONCURRENCY);
  });
});
