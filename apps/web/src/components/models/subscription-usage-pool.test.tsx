import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SubscriptionUsagePoolView,
  ConnectedSubscriptionUsagePool,
} from "./subscription-usage-pool";
import { pooledLimitsFixture, POOL_PREVIEW_NOW } from "@/dev/ui-kit/pages/models/pooled-limits";
import { retainSharedQueries, invalidateSharedQueries } from "@/lib/shared-query";
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

test("shows weighted account bars, runout basis and both windows without financial units", async () => {
  await act(async () =>
    root.render(
      <SubscriptionUsagePoolView
        pool={pooledLimitsFixture("organization")}
        now={POOL_PREVIEW_NOW}
      />,
    ),
  );
  expect(container.textContent).toContain("48% of the pool left");
  expect(container.textContent).toContain("Runs out about");
  expect(container.textContent).toContain("1h 30m before the next reset");
  expect(container.textContent).toContain("last 7 days");
  expect(container.innerHTML).toContain("width: 10%");
  expect(container.textContent).not.toMatch(/\$|dollars|cost|tokens/i);
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "5-hour")!;
  await act(async () => button.click());
  expect(container.textContent).toContain("72% of the pool left");
  expect(container.textContent).toContain("Won't run out; about 30% will go unused (lowest 28%)");
});

test("workspace scope and sparse/unknown readings remain truthful", async () => {
  const pool = pooledLimitsFixture("workspace", true);
  pool.windows[0]!.remainingPercent = null;
  pool.windows[0]!.accounts[0]!.remainingPercent = null;
  await act(async () =>
    root.render(<SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />),
  );
  expect(container.textContent).not.toContain("Operations");
  expect(container.textContent).toContain("Forecast unavailable");
  expect(container.textContent).toContain("Pool usage incomplete");
  expect(container.textContent).toContain("Not reported");
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
  await act(async () => invalidateSharedQueries(client, ["subscription-usage-pools"]));
  expect(reads).toBe(2);
  release();
});

test("loading and failure states do not invent a pool percentage", async () => {
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
  expect(container.textContent).toContain("Loading Codex pool");
  await act(async () => reject(new Error("unavailable")));
  expect(container.textContent).toContain("Couldn't update Codex pool");
  expect(container.textContent).not.toContain("% of the pool left");
});
