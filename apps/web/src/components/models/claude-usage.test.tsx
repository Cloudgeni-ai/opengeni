import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClaudeSubscriptionUsage } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  ClaudeUsage,
  ClaudeUsageReadout,
  claudeUsageReadings,
  claudeUsageReportedAt,
  useClaudeUsage,
  type ClaudeUsageState,
} from "./claude-usage";

let root: Root, container: HTMLDivElement;
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
const usage = (version = 1): ClaudeSubscriptionUsage => ({
  connected: true,
  credentialVersion: version,
  windows: [
    {
      id: "five_hour",
      usedPercent: 100,
      resetsAt: "2099-09-30T16:20:00Z",
      status: "rejected",
      observedAt: "2026-09-30T14:00:00Z",
    },
    {
      id: "seven_day",
      usedPercent: 50,
      resetsAt: "2099-10-03T22:00:00Z",
      status: "allowed",
      observedAt: "2026-09-30T14:00:00Z",
    },
  ],
  observedAt: "2026-09-30T14:00:00Z",
  source: "response_headers",
  refreshStatus: "scope_required",
  refreshCheckedAt: "2026-09-30T14:01:00Z",
});
test("meters use remaining percentages, retain exact resets and invalidate elapsed windows", () => {
  const readings = claudeUsageReadings(usage(), Date.parse("2026-09-30T14:00:00Z"));
  expect(readings.map((reading) => [reading.label, reading.percent])).toEqual([
    ["Weekly", 50],
    ["5-hour", 0],
  ]);
  const expired = usage();
  expired.windows[0]!.resetsAt = "2026-09-30T13:59:00Z";
  expect(claudeUsageReadings(expired, Date.parse("2026-09-30T14:00:00Z"))[1]).toEqual({
    label: "5-hour",
    percent: null,
  });
  expect(claudeUsageReadings(null, 0).every((reading) => reading.percent === null)).toBe(true);
});
test("near-full allowed quotas stay available and explicit rejection needs no invented percentage", async () => {
  const value = usage();
  value.windows = [{ ...value.windows[0]!, usedPercent: 99.6, status: "allowed" }];
  const state: ClaudeUsageState = {
    value,
    loading: false,
    refreshing: false,
    error: false,
    canRefresh: false,
    refresh: async () => {},
  };
  await act(async () =>
    root.render(
      <>
        <ClaudeUsage state={state} />
        <ClaudeUsageReadout state={state} />
      </>,
    ),
  );
  expect(container.textContent).toContain("<1% left");
  expect(container.textContent).not.toContain("Limit reached");
  value.windows[0] = { ...value.windows[0]!, usedPercent: null, status: "rejected" };
  await act(async () =>
    root.render(
      <>
        <ClaudeUsage state={{ ...state }} />
        <ClaudeUsageReadout state={{ ...state }} />
      </>,
    ),
  );
  expect(container.querySelector('[data-slot="usage-readout"]')?.textContent).toBe("Limit reached");
  expect(
    container.querySelector('[data-slot="usage-readout"]')?.hasAttribute("aria-valuenow"),
  ).toBe(false);
  expect(container.querySelector('[data-level="exhausted"]')).not.toBeNull();
});
test("fresh partial headers cannot make an older retained weekly reading look current", () => {
  const value = usage();
  value.windows[0]!.observedAt = "2026-09-30T14:00:00Z";
  value.windows[1]!.observedAt = "2026-09-29T14:00:00Z";
  expect(claudeUsageReportedAt(value, Date.parse("2026-09-30T14:00:00Z"))).toBe(
    "2026-09-29T14:00:00Z",
  );
});
test("an external credential rotation reloads metadata and resumes usage reads", async () => {
  let serverVersion = 1,
    metadataReads = 0;
  const client = {
    getOrganizationClaudeSubscriptionUsage: async () => usage(serverVersion),
    refreshOrganizationClaudeSubscriptionUsage: async () => usage(serverVersion),
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness() {
    const [version, setVersion] = useState(1);
    state = useClaudeUsage({
      client,
      scope: "organization",
      scopeId: "org",
      enabled: true,
      connected: true,
      credentialVersion: version,
      canManage: true,
      onCredentialChanged: async () => {
        metadataReads++;
        setVersion(serverVersion);
      },
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  serverVersion = 2;
  await act(async () => state.refresh());
  expect(state.value?.credentialVersion).toBe(2);
  expect(state.error).toBe(false);
  expect(metadataReads).toBe(1);
});
test("shared usage components explain scope errors and never claim unknown quotas are full", async () => {
  const state: ClaudeUsageState = {
    value: usage(),
    loading: false,
    refreshing: false,
    error: false,
    canRefresh: true,
    refresh: async () => {},
  };
  await act(async () => root.render(<ClaudeUsage state={state} />));
  expect(container.querySelector('[data-slot="usage-meter-group"]')).not.toBeNull();
  expect(container.textContent).toContain("50% left");
  expect(container.textContent).toContain("Limit reached");
  expect(container.textContent).toContain("Usage readings update after Claude is used");
  expect(container.textContent).toContain("Sign in again to check current usage and reset times");
  expect(
    container.querySelector('button[aria-label="Check usage now"]')?.getAttribute("aria-disabled"),
  ).toBe("true");
  await act(async () => root.render(<ClaudeUsage state={{ ...state, value: null }} />));
  expect(container.textContent).toContain("Not reported yet");
  expect(container.textContent).not.toContain("100% left");
});
test("usage requests stay disabled with the provider flag and stale scope/version results are discarded", async () => {
  let finish!: (usage: ClaudeSubscriptionUsage) => void;
  const pending = new Promise<ClaudeSubscriptionUsage>((resolve) => {
    finish = resolve;
  });
  const scopes: string[] = [];
  const client = {
    getWorkspaceClaudeSubscriptionUsage: async (scope: string) => {
      scopes.push(scope);
      return scope === "one" ? pending : usage(2);
    },
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness({
    scope,
    enabled,
    version,
  }: {
    scope: string;
    enabled: boolean;
    version: number;
  }) {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: scope,
      enabled,
      connected: true,
      credentialVersion: version,
      canManage: false,
    });
    return null;
  }
  await act(async () => root.render(<Harness scope="one" enabled={false} version={1} />));
  expect(scopes).toEqual([]);
  await act(async () => root.render(<Harness scope="one" enabled version={1} />));
  await act(async () => root.render(<Harness scope="two" enabled version={2} />));
  await act(async () => finish(usage(1)));
  expect(state.value?.credentialVersion).toBe(2);
  expect(scopes).toEqual(["one", "two"]);
  expect(state.canRefresh).toBe(false);
});
test("credentials replaced mid-refresh cannot revive an old reading", async () => {
  let finish!: (usage: ClaudeSubscriptionUsage) => void;
  const pending = new Promise<ClaudeSubscriptionUsage>((resolve) => {
    finish = resolve;
  });
  let version = 1;
  const client = {
    getOrganizationClaudeSubscriptionUsage: async () => usage(version),
    refreshOrganizationClaudeSubscriptionUsage: async () => pending,
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness({ credentialVersion }: { credentialVersion: number }) {
    state = useClaudeUsage({
      client,
      scope: "organization",
      scopeId: "org",
      enabled: true,
      connected: true,
      credentialVersion,
      canManage: true,
    });
    return null;
  }
  await act(async () => root.render(<Harness credentialVersion={1} />));
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = state.refresh();
  });
  expect(state.refreshing).toBe(true);
  version = 2;
  await act(async () => root.render(<Harness credentialVersion={2} />));
  await act(async () => {
    finish(usage(1));
    await refresh;
  });
  expect(state.value?.credentialVersion).toBe(2);
  expect(state.refreshing).toBe(false);
});

test("refresh failure preserves the last reported quota", async () => {
  const client = {
    getWorkspaceClaudeSubscriptionUsage: async () => usage(),
    refreshWorkspaceClaudeSubscriptionUsage: async () => {
      throw new Error("Usage service unavailable");
    },
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness() {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: "connection",
      credentialVersion: 1,
      canManage: true,
    });
    return <ClaudeUsage state={state} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => state.refresh());
  expect(state.value).toEqual(usage());
  expect(state.error).toBe(true);
  expect(state.refreshing).toBe(false);
  expect(container.textContent).toContain("50% left");
  expect(container.textContent).toContain("Couldn't check usage");
});

test("recreated connections discard in-flight results even when their versions match", async () => {
  let finish!: (usage: ClaudeSubscriptionUsage) => void;
  const pending = new Promise<ClaudeSubscriptionUsage>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const fresh = { ...usage(), windows: [] };
  const client = {
    getWorkspaceClaudeSubscriptionUsage: async () => (++calls === 1 ? pending : fresh),
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness({ id }: { id: string }) {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: id,
      credentialVersion: 1,
      canManage: true,
    });
    return null;
  }
  await act(async () => root.render(<Harness id="old" />));
  await act(async () => root.render(<Harness id="new" />));
  await act(async () => finish(usage()));
  expect(state.value).toEqual(fresh);
  expect(calls).toBe(2);
});
