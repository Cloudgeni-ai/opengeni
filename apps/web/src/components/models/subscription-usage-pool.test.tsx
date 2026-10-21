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
} from "@opengeni/react/app/lib/shared-query";
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

test("shows weekly utilization and one weighted total bar without an account breakdown", async () => {
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
  expect(container.textContent).toContain("Team Plus is at its 5-hour limit until");
  expect(container.textContent).not.toContain("Team Pro 1");
  expect(container.textContent).not.toContain("Team Pro 2");
  expect(container.querySelectorAll('[role="meter"]')).toHaveLength(1);
  expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("65.61");
  expect(container.querySelector('[aria-label="Account limits"]')).toBeNull();
  expect(container.querySelectorAll("li")).toHaveLength(0);
  expect(container.textContent).toContain("Total remaining");
  expect(container.textContent).toContain("66% left");
  expect(container.textContent).toContain("Read 3 min ago");
  expect(container.textContent).not.toContain("Bar sizes");
  expect(container.textContent).not.toMatch(/\$|dollars|cost|tokens/i);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).not.toContain("of the pool left");
  expect(container.textContent).not.toContain("will go unused");
});

test("run-out headline names the time and gap to the next reset", async () => {
  const pool = pooledLimitsFixture("organization", false, true);
  const weekly = pool.windows.find((window) => window.id === "weekly")!;
  expect(Date.parse(weekly.forecast.nextResetAt!)).toBe(
    Math.min(...weekly.accounts.map((account) => Date.parse(account.resetsAt!))),
  );
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
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
  expect(container.textContent).not.toContain("Team Pro 2");
  expect(container.textContent).toContain("No account has reported its limit yet");
  expect(container.textContent).toContain("Not reported");
  expect(container.querySelectorAll('[role="meter"]')).toHaveLength(0);
  expect(
    container.querySelector('[data-slot="usage-meter"]')?.getAttribute("aria-valuenow"),
  ).toBeNull();
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

test("workspace preview combines shared and owned accounts in one total without splitting their usage", async () => {
  const pool = pooledLimitsFixture("workspace");
  const organization = pooledLimitsFixture("organization");
  for (const account of pool.windows[0]!.accounts) {
    expect(account).toEqual(
      organization.windows[0]!.accounts.find((entry) => entry.id === account.id)!,
    );
  }
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).not.toContain("Team Pro 1");
  expect(container.textContent).not.toContain("Team Pro 2");
  expect(container.querySelectorAll('[role="meter"]')).toHaveLength(1);
  expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("61.82");
  expect(container.querySelectorAll("li")).toHaveLength(0);
  expect(container.textContent!.match(/this week's included usage/g)).toHaveLength(1);
});

test("empty and full reported totals retain a single bounded meter", async () => {
  for (const percent of [0, 100]) {
    const pool = pooledLimitsFixture("organization");
    pool.windows[0]!.remainingPercent = percent;
    await act(async () =>
      root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
    );
    expect(container.querySelectorAll('[role="meter"]')).toHaveLength(1);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe(
      String(percent),
    );
  }
});

test("expired five-hour blockers disappear and a workspace with no available accounts shows nothing", async () => {
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

test("workspace loading and failure show no pool until available accounts are established", async () => {
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

test("an unreported account is named as left out of a total the others still give, aligned with the account rows", async () => {
  const pool = pooledLimitsFixture("organization");
  const weekly = pool.windows.find((window) => window.id === "weekly")!;
  weekly.accounts = weekly.accounts.map((account, index) =>
    index === 1 ? { ...account, remainingPercent: null } : account,
  );
  weekly.remainingPercent = 61.82;
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).toContain("62% left");
  expect(container.textContent).toContain(
    "Leaves out Team Pro 2, which hasn't reported its limit yet.",
  );
  expect(container.textContent).toContain("Read 3 min ago.");
  // The same inset as list rows, so the bar lines up with their dividers.
  expect(container.querySelector("section")!.className).toContain("px-3");
});
