import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM loads (see agent-can-use.test.tsx).
GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "11111111-1111-4111-8111-111111111111";
const agentId = "33333333-3333-4333-8333-333333333333";

const reads: Array<{ workspaceId: string; options: unknown }> = [];
let respond: () => Promise<unknown> = async () => ({});
const grant = (permissions: string[]) => ({
  workspaceId,
  accountId,
  subjectId: "user:viewer",
  permissions,
});
const context = {
  client: {
    getWorkspaceInsightsUsage: async (id: string, options: unknown) => {
      reads.push({ workspaceId: id, options });
      return await respond();
    },
  },
  accessContext: {
    mode: "managed",
    subjectId: "user:viewer",
    accountGrants: [],
    workspaceGrants: [grant(["workspace:admin"])],
  } as Record<string, unknown>,
  workspaces: [{ id: workspaceId, accountId, kind: "shared", name: "Platform" }],
  managedSelfContext: null,
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentCost, agentCostText } = await import("./agent-cost");

afterAll(() => GlobalRegistrator.unregister());

function usage(totals: { chargedMicros: number; listMicros: number }, runs: number) {
  return {
    totals: {
      ...totals,
      byPayer: {
        opengeni_credits: { calls: 1, chargedMicros: totals.chargedMicros, listMicros: 0 },
        subscription: { calls: 1, chargedMicros: 0, listMicros: totals.listMicros },
        own_key: { calls: 0, chargedMicros: 0, listMicros: 0 },
      },
    },
    groupCount: runs,
  };
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  reads.length = 0;
  context.accessContext.workspaceGrants = [grant(["workspace:admin"])];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(<AgentCost agent={{ id: agentId }} workspaceId={workspaceId} />);
  });
  // Let the read settle.
  await act(async () => {
    await Promise.resolve();
  });
  return host.querySelector("[data-agent-cost]")?.textContent ?? null;
}

describe("AgentCost", () => {
  test("shows last 30 days spend and the average per run, as Usage counts spend", async () => {
    // $9.00 charged in credits plus a $3.40 plan list-price estimate, over 40 runs.
    respond = async () => usage({ chargedMicros: 9_000_000, listMicros: 3_400_000 }, 40);
    expect(await render()).toBe("Last 30 days: $12.40 · $0.31 per run");
    expect(reads).toEqual([
      {
        workspaceId,
        options: { range: "30d", agentId, groupBy: "rootSession", limit: 1 },
      },
    ]);
  });

  test("says when the agent had no runs", async () => {
    respond = async () => usage({ chargedMicros: 0, listMicros: 0 }, 0);
    expect(await render()).toBe("No runs in the last 30 days");
  });

  test("is hidden from people who can't see Usage, without asking the server", async () => {
    context.accessContext.workspaceGrants = [grant(["workspace:read", "sessions:create"])];
    respond = async () => usage({ chargedMicros: 1_000_000, listMicros: 0 }, 1);
    expect(await render()).toBeNull();
    expect(reads).toEqual([]);
  });

  test("renders nothing when the server refuses or fails", async () => {
    respond = async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    expect(await render()).toBeNull();
    expect(reads).toHaveLength(1);
  });

  test("formats amounts like Usage", () => {
    expect(agentCostText({ spendMicros: 1_234_560_000, runs: 3 })).toBe(
      "Last 30 days: $1,235 · $411.52 per run",
    );
    expect(agentCostText({ spendMicros: 50_000, runs: 2 })).toBe(
      "Last 30 days: $0.05 · $0.03 per run",
    );
  });
});
