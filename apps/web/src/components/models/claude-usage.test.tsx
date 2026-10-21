import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClaudeSubscriptionUsage } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ClaudeSubscriptionAccount } from "@opengeni/sdk";
import { ClaudeAccountUsageReadout } from "./claude-subscription-models";
import { ModelsRefreshControl } from "./models-refresh-control";
import {
  ClaudeUsage,
  ClaudeUsageReadout,
  claudeUsageReadings,
  claudeUsageReportedAt,
  useClaudeUsage,
  type ClaudeUsageState,
} from "./claude-usage";
import {
  clearSharedQueries,
  invalidateSharedQueries,
  peekSharedQuery,
  retainSharedQueries,
} from "@opengeni/react/app/lib/shared-query";

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
test("an account row says when both plan limits reset, the shown one first", async () => {
  const state: ClaudeUsageState = {
    value: usage(),
    loading: false,
    refreshing: false,
    error: false,
    canRefresh: false,
    refresh: async () => {},
  };
  await act(async () => root.render(<ClaudeUsageReadout state={state} />));
  // The 5-hour limit is reached, so the row shows it and its reset leads.
  expect(container.querySelector('[data-slot="usage-readout"]')?.textContent).toStartWith(
    "Limit reached",
  );
  expect(container.querySelector('[data-slot="usage-readout-resets"]')?.textContent).toMatch(
    /^Resets \d+ (Sep|Oct) 2099 · Weekly \d+ Oct 2099$/,
  );
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
  expect(container.querySelector('[data-slot="usage-readout"]')?.textContent).toStartWith(
    "Limit reached",
  );
  // A reached limit still says when it resets.
  expect(container.querySelector('[data-slot="usage-readout-resets"]')?.textContent).toMatch(
    /^Resets \d+ Sep 2099$/,
  );
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
  let checks = 0;
  const client = {
    refreshOrganizationClaudeSubscriptionUsage: async () =>
      ++checks === 2 ? pending : usage(version),
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
  let checks = 0;
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => {
      if (++checks === 1) return usage();
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
    refreshWorkspaceClaudeSubscriptionUsage: async () => (++calls === 1 ? pending : fresh),
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
test("a revisit shows the last reading at once and never another credential's", async () => {
  let release: ((value: ClaudeSubscriptionUsage) => void) | null = null;
  let reads = 0;
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => {
      reads++;
      if (reads === 1) return usage(1);
      return await new Promise<ClaudeSubscriptionUsage>((resolve) => (release = resolve));
    },
  } as unknown as OpenGeniBrowserClient;
  // The console keeps reads across navigation for its live client.
  const retained = retainSharedQueries(client);
  const firstFrames: (ClaudeUsageState | null)[] = [];
  let state!: ClaudeUsageState;
  function Harness({ version }: { version: number }) {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: "claude-connection",
      credentialVersion: version,
      canManage: true,
    });
    if (firstFrames.length === 0) firstFrames.push(state);
    return null;
  }
  await act(async () => root.render(<Harness version={1} />));
  expect(state.value?.credentialVersion).toBe(1);
  // Leave the page and come back: the first frame already has the reading,
  // and fresh readings do not trigger another request.
  await act(async () => root.render(<></>));
  firstFrames.length = 0;
  await act(async () => root.render(<Harness version={1} />));
  expect(firstFrames[0]?.loading).toBe(false);
  expect(firstFrames[0]?.value?.credentialVersion).toBe(1);
  expect(reads).toBe(1);
  // A replaced credential (new version) never starts from the old reading.
  await act(async () => root.render(<></>));
  firstFrames.length = 0;
  await act(async () => root.render(<Harness version={2} />));
  expect(firstFrames[0]?.value).toBeNull();
  expect(firstFrames[0]?.loading).toBe(true);
  expect(reads).toBe(2);
  await act(async () => release?.(usage(2)));
  retained();
});

function revisitHarness(input: {
  client: OpenGeniBrowserClient;
  credentialId?: string;
  accountPool?: boolean;
  frames: ClaudeUsageState[];
}) {
  return function Harness() {
    const state = useClaudeUsage({
      client: input.client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: input.credentialId,
      credentialVersion: input.credentialId ? 1 : undefined,
      canManage: Boolean(input.credentialId),
      accountPool: input.accountPool ?? false,
    });
    input.frames.push(state);
    return null;
  };
}

test("a reading whose credential is unknown (people who can't manage it) is never retained", async () => {
  const client = {
    getWorkspaceClaudeSubscriptionUsage: async () => usage(1),
  } as unknown as OpenGeniBrowserClient;
  const retained = retainSharedQueries(client);
  const frames: ClaudeUsageState[] = [];
  const Harness = revisitHarness({ client, frames });
  await act(async () => root.render(<Harness />));
  expect(frames.at(-1)?.value?.credentialVersion).toBe(1);
  await act(async () => root.render(<></>));
  frames.length = 0;
  await act(async () => root.render(<Harness />));
  // A replaced credential could not be told apart, so the revisit starts cold.
  expect(frames[0]?.value).toBeNull();
  expect(frames[0]?.loading).toBe(true);
  retained();
});

test("an access refusal drops the retained reading", async () => {
  let refuse = false;
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => {
      if (refuse) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return usage(1);
    },
  } as unknown as OpenGeniBrowserClient;
  const retained = retainSharedQueries(client);
  const frames: ClaudeUsageState[] = [];
  const Harness = revisitHarness({ client, credentialId: "claude-connection", frames });
  await act(async () => root.render(<Harness />));
  expect(frames.at(-1)?.value?.credentialVersion).toBe(1);
  await act(async () => root.render(<></>));
  refuse = true;
  frames.length = 0;
  await act(async () => root.render(<Harness />));
  // Explicit Models refresh re-reads fresh data too; a refusal removes it.
  expect(frames[0]?.value?.credentialVersion).toBe(1);
  await act(async () => invalidateSharedQueries(client, ["model-settings"]));
  expect(frames.at(-1)?.value).toBeNull();
  expect(frames.at(-1)?.error).toBe(true);
  expect(
    peekSharedQuery(client, [
      "model-settings",
      "claude-usage",
      "workspace",
      "workspace",
      "connection",
      "claude-connection",
      1,
      "live",
    ])?.data,
  ).toBeNull();
  await act(async () => root.render(<></>));
  frames.length = 0;
  await act(async () => root.render(<Harness />));
  expect(frames[0]?.value).toBeNull();
  retained();
});

test("readers share a single request, retain it for five minutes, and share explicit live refresh", async () => {
  let reads = 0,
    checks = 0;
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const client = {
    getClaudeSubscriptionAccountUsage: async () => {
      reads++;
      return usage();
    },
    refreshClaudeSubscriptionAccountUsage: async () => {
      checks++;
      return { ...usage(), windows: [] };
    },
  } as unknown as OpenGeniBrowserClient;
  const retained = retainSharedQueries(client);
  const frames: ClaudeUsageState[] = [];
  const Harness = revisitHarness({ client, credentialId: "account", accountPool: true, frames });
  try {
    await act(async () =>
      root.render(
        <>
          <Harness />
          <Harness />
        </>,
      ),
    );
    expect(reads).toBe(0);
    expect(checks).toBe(1);
    await act(async () => root.render(<></>));
    now += 5 * 60_000 - 1;
    await act(async () => root.render(<Harness />));
    expect(checks).toBe(1);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(checks).toBe(1);
    await act(async () => root.render(<></>));
    now++;
    await act(async () =>
      root.render(
        <>
          <Harness />
          <Harness />
        </>,
      ),
    );
    expect(checks).toBe(2);
    await act(async () => frames.at(-1)!.refresh());
    expect(checks).toBe(3);
    expect(frames.slice(-2).every((state) => state.value?.windows.length === 0)).toBe(true);
    await act(async () => invalidateSharedQueries(client, ["model-settings"]));
    expect(checks).toBe(4);
    expect(reads).toBe(0);
  } finally {
    clock.mockRestore();
    retained();
  }
});

test("switching clients never renders the previous client's usage", async () => {
  const first = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => usage(),
  } as unknown as OpenGeniBrowserClient;
  let finish!: (value: ClaudeSubscriptionUsage) => void;
  const second = {
    refreshWorkspaceClaudeSubscriptionUsage: () =>
      new Promise<ClaudeSubscriptionUsage>((resolve) => {
        finish = resolve;
      }),
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness({ client }: { client: OpenGeniBrowserClient }) {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: "same-id",
      credentialVersion: 1,
      canManage: true,
    });
    return null;
  }
  await act(async () => root.render(<Harness client={first} />));
  expect(state.value).toEqual(usage());
  await act(async () => root.render(<Harness client={second} />));
  expect(state.value).toBeNull();
  expect(state.loading).toBe(true);
  await act(async () => finish({ ...usage(), windows: [] }));
  expect(state.value?.windows).toEqual([]);
});

test("a clear during a live check discards the late response", async () => {
  let finish!: (value: ClaudeSubscriptionUsage) => void;
  let current = usage();
  let checks = 0;
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () =>
      ++checks === 2
        ? new Promise<ClaudeSubscriptionUsage>((resolve) => {
            finish = resolve;
          })
        : current,
  } as unknown as OpenGeniBrowserClient;
  const frames: ClaudeUsageState[] = [];
  const Harness = revisitHarness({ client, credentialId: "account", frames });
  await act(async () => root.render(<Harness />));
  let checking!: Promise<void>;
  await act(async () => {
    checking = frames.at(-1)!.refresh();
  });
  current = { ...usage(), windows: [] };
  await act(async () => clearSharedQueries(client));
  await act(async () => {
    finish(usage());
    await checking;
  });
  expect(frames.at(-1)?.value).toEqual(current);
});

test("a shared revalidation reporting reconnect reloads metadata only once", async () => {
  let reconnect = false,
    metadataReads = 0;
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => ({
      ...usage(),
      refreshStatus: reconnect ? "reconnect" : "not_checked",
    }),
  } as unknown as OpenGeniBrowserClient;
  let state!: ClaudeUsageState;
  function Harness() {
    state = useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      enabled: true,
      connected: true,
      credentialId: "account",
      credentialVersion: 1,
      canManage: true,
      onCredentialChanged: async () => {
        metadataReads++;
      },
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  reconnect = true;
  await act(async () => invalidateSharedQueries(client, ["model-settings"]));
  expect(state.value?.refreshStatus).toBe("reconnect");
  expect(metadataReads).toBe(1);
  await act(async () => invalidateSharedQueries(client, ["model-settings"]));
  expect(metadataReads).toBe(1);
});

test("a pool account's reading and the connection's reading never share an entry", async () => {
  const client = {
    refreshWorkspaceClaudeSubscriptionUsage: async () => usage(1),
    refreshClaudeSubscriptionAccountUsage: async () => usage(1),
  } as unknown as OpenGeniBrowserClient;
  const retained = retainSharedQueries(client);
  const frames: ClaudeUsageState[] = [];
  const Connection = revisitHarness({ client, credentialId: "shared-id", frames });
  await act(async () => root.render(<Connection />));
  await act(async () => root.render(<></>));
  frames.length = 0;
  const PoolAccount = revisitHarness({
    client,
    credentialId: "shared-id",
    accountPool: true,
    frames,
  });
  await act(async () => root.render(<PoolAccount />));
  expect(frames[0]?.value).toBeNull();
  retained();
});

for (const scope of ["workspace", "organization"] as const) {
  test(`global Refresh and stale ${scope} Claude meters check live once, fresh mounts do not`, async () => {
    let now = Date.now(),
      liveChecks = 0,
      storedReads = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let reading = usage();
    const live = async () => {
      liveChecks++;
      return reading;
    };
    const stored = async () => {
      storedReads++;
      return usage();
    };
    const client = {
      refreshClaudeSubscriptionAccountUsage: live,
      refreshOrganizationClaudeSubscriptionAccountUsage: live,
      getClaudeSubscriptionAccountUsage: stored,
      getOrganizationClaudeSubscriptionAccountUsage: stored,
    } as unknown as OpenGeniBrowserClient;
    const retain = retainSharedQueries(client);
    const account = {
      id: "account",
      version: 1,
      status: "active",
      allocatorEnabled: true,
    } as ClaudeSubscriptionAccount;
    let detail!: ClaudeUsageState;
    function Harness() {
      detail = useClaudeUsage({
        client,
        scope,
        scopeId: "scope",
        credentialId: account.id,
        credentialVersion: account.version,
        enabled: true,
        connected: true,
        canManage: true,
        accountPool: true,
      });
      return (
        <>
          <ModelsRefreshControl client={client} />
          <ClaudeAccountUsageReadout
            client={client}
            scope={scope}
            scopeId="scope"
            account={account}
            canManage
          />
        </>
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      expect(liveChecks).toBe(1);
      expect(storedReads).toBe(0);
      await act(async () => root.render(<></>));
      now += 5 * 60_000 - 1;
      await act(async () => root.render(<Harness />));
      expect(liveChecks).toBe(1);
      await act(async () => root.render(<></>));
      now++;
      await act(async () => root.render(<Harness />));
      expect(liveChecks).toBe(2);
      reading = { ...usage(), windows: [{ ...usage().windows[1]!, usedPercent: 25 }] };
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button")!.click();
      });
      expect(liveChecks).toBe(3);
      expect(storedReads).toBe(0);
      expect(detail.value).toEqual(reading);
      expect(container.textContent).toContain("75% left");
      expect(container.textContent).not.toContain("Refreshing…");
    } finally {
      clock.mockRestore();
      retain();
    }
  });
}

test("read-only usage never attempts the live mutation, including global Refresh", async () => {
  let storedReads = 0,
    liveChecks = 0;
  const client = {
    getClaudeSubscriptionAccountUsage: async () => {
      storedReads++;
      return usage();
    },
    refreshClaudeSubscriptionAccountUsage: async () => {
      liveChecks++;
      return usage();
    },
  } as unknown as OpenGeniBrowserClient;
  function Harness() {
    useClaudeUsage({
      client,
      scope: "workspace",
      scopeId: "workspace",
      credentialId: "account",
      credentialVersion: 1,
      enabled: true,
      connected: true,
      canManage: false,
      accountPool: true,
    });
    return <ModelsRefreshControl client={client} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(storedReads).toBe(2);
  expect(liveChecks).toBe(0);
});

for (const cold of [true, false]) {
  test(`Claude row reports unavailable after a failed ${cold ? "initial check" : "global refresh"}`, async () => {
    let fail = cold;
    const client = {
      refreshClaudeSubscriptionAccountUsage: async () => {
        if (fail) throw new Error("Provider unavailable");
        return {
          ...usage(),
          refreshStatus: "ok",
          windows: [{ ...usage().windows[1]!, usedPercent: 25 }],
        };
      },
    } as unknown as OpenGeniBrowserClient;
    const account = {
      id: "account",
      version: 1,
      status: "active",
      allocatorEnabled: true,
    } as ClaudeSubscriptionAccount;
    function Harness() {
      return (
        <>
          <ModelsRefreshControl client={client} />
          <ClaudeAccountUsageReadout
            client={client}
            scope="workspace"
            scopeId="workspace"
            account={account}
            canManage
          />
        </>
      );
    }
    await act(async () => root.render(<Harness />));
    if (!cold) {
      expect(container.textContent).toContain("75% left");
      fail = true;
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    }
    expect(container.textContent).toContain("Usage unavailable");
    expect(container.textContent).not.toContain("No usage yet");
    expect(container.textContent).not.toContain("75% left");
  });
}
