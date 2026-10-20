import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SubscriptionUsagePoolView,
  ConnectedSubscriptionUsagePool,
} from "./subscription-usage-pool";
import { pooledLimitsFixture, POOL_PREVIEW_NOW } from "@/dev/ui-kit/pages/models/pooled-limits";
import {
  retainSharedQueries,
  invalidateSharedQueries,
  invalidateSubscriptionAccountQueries,
} from "@/lib/shared-query";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

test("shows weekly utilization and weighted details, with only currently blocking five-hour limits", async () => {
  await act(async () =>
    root.render(
      <SubscriptionUsagePoolView
        pool={pooledLimitsFixture("organization")}
        now={POOL_PREVIEW_NOW}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "At this pace you'll use about 50% of this week's included usage.",
  );
  expect(container.textContent).toContain("Last 7 days, adjusted to this week's pace.");
  expect(container.textContent).toContain("Design · Plus is at its 5-hour limit until");
  expect(container.textContent).not.toContain("Engineering · Pro is at its 5-hour limit");
  expect(container.innerHTML).toContain("width: 10%");
  expect(container.textContent).not.toMatch(/\$|dollars|cost|tokens/i);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).not.toContain("of the pool left");
  expect(container.textContent).not.toContain("will go unused");
});

test("run-out headline names the time and gap to the next reset", async () => {
  await act(async () =>
    root.render(
      <SubscriptionUsagePoolView
        pool={pooledLimitsFixture("organization", false, true)}
        now={POOL_PREVIEW_NOW}
      />,
    ),
  );
  expect(container.textContent).toContain("At this pace you'll run out");
  expect(container.textContent).toContain("1 day before the next reset.");
});

test("workspace scope and sparse/unknown readings remain truthful", async () => {
  const pool = pooledLimitsFixture("workspace", true);
  pool.windows[0]!.remainingPercent = null;
  pool.windows[0]!.accounts[0]!.remainingPercent = null;
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).not.toContain("Operations");
  expect(container.textContent).toContain("Some account limits aren't available yet");
  expect(container.textContent).toContain("Not reported");
});

test("limited history remains visible without a fabricated utilization number", async () => {
  await act(async () =>
    root.render(
      <SubscriptionUsagePoolView
        pool={pooledLimitsFixture("organization", true)}
        now={POOL_PREVIEW_NOW}
      />,
    ),
  );
  expect(container.textContent).toContain("Not enough history to forecast");
  expect(container.textContent).not.toContain("you'll use about");
});

test("expired five-hour blockers disappear and a workspace with no owned accounts shows nothing", async () => {
  const pool = pooledLimitsFixture("workspace");
  for (const account of pool.windows.find((window) => window.id === "five_hour")!.accounts)
    account.resetsAt = new Date(POOL_PREVIEW_NOW - 1).toISOString();
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).not.toContain("5-hour");
  pool.windows.forEach((window) => {
    window.accounts = [];
  });
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).toBe("");
});

test("all providers share one client-scoped request and refresh invalidation", async () => {
  let reads = 0;
  const client = {
    getWorkspaceSubscriptionUsagePools: async () => {
      reads++;
      return { pools: [pooledLimitsFixture("workspace")], checkedAt: new Date().toISOString() };
    },
  } as unknown as OpenGeniBrowserClient;
  const release = retainSharedQueries(client);
  await act(async () =>
    root.render(
      <ul>
        <ConnectedSubscriptionUsagePool client={client} scope="workspace" id="w" provider="codex" />
        <ConnectedSubscriptionUsagePool
          client={client}
          scope="workspace"
          id="w"
          provider="claude"
        />
      </ul>,
    ),
  );
  expect(reads).toBe(1);
  await act(async () => invalidateSubscriptionAccountQueries(client, false));
  expect(reads).toBe(1);
  await act(async () => invalidateSharedQueries(client, ["subscription-usage-pools"]));
  expect(reads).toBe(2);
  release();
});

test("workspace loading and failure show no pool until owned accounts are established", async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const client = {
    getWorkspaceSubscriptionUsagePools: () => pending,
  } as unknown as OpenGeniBrowserClient;
  await act(async () =>
    root.render(
      <ul>
        <ConnectedSubscriptionUsagePool client={client} scope="workspace" id="w" provider="codex" />
      </ul>,
    ),
  );
  expect(container.textContent).toBe("");
  await act(async () => reject(new Error("unavailable")));
  expect(container.textContent).toBe("");
});
