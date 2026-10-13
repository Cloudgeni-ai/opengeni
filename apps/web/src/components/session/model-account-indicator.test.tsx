import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelAccountChoiceOption, SessionModelAccountChoiceResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { fakeClient, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";

{
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}
const { OpenGeniProvider } = await import("@opengeni/react");
const { ModelAccountIndicator } = await import("./model-account-indicator");
afterAll(() => GlobalRegistrator.unregister());

const ORG = "00000000-0000-4000-8000-0000000000aa";

function option(
  connectionId: string,
  label: string,
  extra: Partial<ModelAccountChoiceOption> = {},
): ModelAccountChoiceOption {
  return {
    provider: "claude",
    connectionId,
    label,
    accountEmail: null,
    planType: null,
    status: "active",
    personal: false,
    source: "organization",
    allowedModelIds: null,
    choosable: true,
    refusal: null,
    ...extra,
  };
}

function choiceResponse(
  overrides: Partial<SessionModelAccountChoiceResponse> = {},
): SessionModelAccountChoiceResponse {
  return {
    binding: null,
    bindings: [],
    accounts: [
      option("shared-1", "Team Claude"),
      option("mine-1", "My Claude", { personal: true, source: "personal" }),
      option("other-provider", "Team Codex", { provider: "codex" }),
    ],
    personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn: false },
    ...overrides,
  };
}

async function render(
  client: ReturnType<typeof fakeClient>,
  provider = "claude",
  servingTurnId?: string,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <ModelAccountIndicator
          workspaceId={WORKSPACE_ID}
          sessionId="session-1"
          organizationId={ORG}
          provider={provider}
          servingTurnId={servingTurnId}
          events={[]}
        />
      </OpenGeniProvider>,
    ),
  );
  return {
    container,
    async open() {
      const trigger = container.querySelector("button")!;
      await act(async () =>
        trigger.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
        ),
      );
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].map(
    (row) => row.textContent ?? "",
  );

test("SUB-FAIL-06 current serving account is distinct from next-turn explicit choice", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        bindings: [{ provider: "claude", choice: "explicit", connectionId: "mine-1" }],
        serving: {
          turnId: "turn-1",
          provider: "claude",
          connectionId: "shared-1",
          modelId: "claude-sub/opus",
          preferredModelId: "claude-sub/opus",
          reasoningEffort: "high",
          latencyMode: "standard",
        },
      }),
  });
  const view = await render(client, "claude", "turn-1");
  try {
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toContain(
      "Team Claude",
    );
    await view.open();
    expect(document.body.textContent).toContain("Current account");
    const selected = [...document.querySelectorAll('[role="menuitem"]')].find((row) =>
      row.querySelector('[data-slot="dropdown-menu-check"] svg'),
    );
    expect(selected?.textContent).toContain("My Claude");
  } finally {
    await view.cleanup();
  }
});

test("SUB-FAIL-06 a withheld serving identity never borrows the chosen account label", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        bindings: [{ provider: "claude", choice: "explicit", connectionId: "mine-1" }],
        serving: {
          turnId: "turn-1",
          provider: "claude",
          connectionId: null,
          modelId: "claude-sub/opus",
          preferredModelId: "claude-sub/opus",
          reasoningEffort: "high",
          latencyMode: "standard",
        },
      }),
  });
  const view = await render(client, "claude", "turn-1");
  try {
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toContain(
      "Account unavailable",
    );
  } finally {
    await view.cleanup();
  }
});

test("offers only the session provider's accounts, with the caller's own accounts grouped", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => choiceResponse(),
    updateModelAccountPreferences: async () => ({ personalFallbackOptIn: false, version: 0 }),
  });
  const view = await render(client);
  try {
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Model account · Automatic",
    );
    await view.open();
    const items = menuItems();
    expect(items).toEqual(["Automatic", "Team Claude", "My Claude"]);
    expect(document.body.textContent).toContain("Your accounts");
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("renders nothing when the provider has no accounts on the shared core", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({ accounts: [option("x", "Team Codex", { provider: "codex" })] }),
  });
  const view = await render(client);
  try {
    expect(view.container.querySelector("button")).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("choosing sends the account and shows where it applies; a refused account is disabled", async () => {
  const calls: Array<string | null> = [];
  let current = choiceResponse({
    accounts: [
      option("shared-1", "Team Claude"),
      option("mine-1", "My Claude", {
        personal: true,
        source: "personal",
        choosable: false,
        refusal: "personal_not_owner_work",
      }),
    ],
  });
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => current,
    setSessionModelAccount: async (
      _workspaceId: string,
      _sessionId: string,
      request: { connectionId: string | null },
    ) => {
      calls.push(request.connectionId);
      current = {
        ...current,
        binding: { provider: "claude", connectionId: request.connectionId, choice: "explicit" },
      };
      return {
        changed: true,
        appliedTo: "next_turn" as const,
        provider: "claude",
        connectionId: request.connectionId,
        choice: "explicit" as const,
      };
    },
  });
  const view = await render(client);
  try {
    await view.open();
    const mine = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
      row.textContent?.includes("My Claude"),
    )!;
    expect(mine.getAttribute("aria-disabled") ?? mine.getAttribute("data-disabled")).not.toBeNull();
    expect(mine.textContent).toContain("Not available for this chat");
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    const team = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
      row.textContent?.includes("Team Claude"),
    )!;
    await act(async () => team.click());
    expect(calls).toEqual(["shared-1"]);
    expect(document.body.textContent).toContain("Selection saved for the next turn.");
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Model account · Team Claude",
    );
  } finally {
    await view.cleanup();
  }
});

test.each(["claude", "xai", "codex"])(
  "uses the subscription provider mark for %s",
  async (provider) => {
    const client = Object.assign(fakeClient({}), {
      getSessionModelAccount: async () =>
        choiceResponse({
          accounts: [option("team", "Team account", { provider })],
        }),
    });
    const view = await render(client, provider);
    try {
      expect(
        view.container.querySelector(
          `[data-testid="billing-class-icon-${provider === "xai" ? "supergrok" : provider}_subscription"]`,
        ),
      ).not.toBeNull();
      await view.open();
      expect(
        document
          .querySelector('[role="menu"]')
          ?.querySelector(
            `[data-testid="billing-class-icon-${provider === "xai" ? "supergrok" : provider}_subscription"]`,
          ),
      ).not.toBeNull();
      expect(document.body.textContent).toContain("Choose an account to view usage");
      expect(document.querySelector('[role="progressbar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

test("renders the API's cached windows without an aggregate remaining estimate or refresh", async () => {
  let refreshes = 0;
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        binding: { provider: "claude", connectionId: "team", choice: "explicit" },
        accounts: [
          option("team", "Team Claude", {
            usage: {
              observedAt: "2020-01-01T00:00:00Z",
              source: "response_headers",
              windows: [
                {
                  id: "five_hour",
                  usedPercent: 36,
                  resetsAt: "2020-01-01T01:00:00Z",
                  status: "ok",
                },
                { id: "seven_day", usedPercent: null, resetsAt: null, status: "unknown" },
                { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
              ],
              exhaustedKind: null,
              exhaustedUntil: null,
            },
          }),
        ],
      }),
    refreshCodexUsage: async () => {
      refreshes += 1;
      throw new Error("No legacy refresh");
    },
  });
  const view = await render(client);
  try {
    await view.open();
    expect(document.querySelector('[aria-label="5h used"]')?.getAttribute("aria-valuenow")).toBe(
      "36",
    );
    expect(
      document.querySelector('[aria-label="Overage used"]')?.getAttribute("aria-valuetext"),
    ).toBe("125% used");
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(document.body.textContent).toContain("Cached observation");
    expect(document.body.textContent).toContain("Reset time passed; current usage unknown");
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).not.toContain("% remaining");
    expect(refreshes).toBe(0);
  } finally {
    await view.cleanup();
  }
});

test.each([
  { usage: null, expected: "No stored usage" },
  { usage: undefined, expected: "Usage not reported" },
])(
  "distinguishes absent snapshots from omitted projection: $expected",
  async ({ usage, expected }) => {
    const client = Object.assign(fakeClient({}), {
      getSessionModelAccount: async () =>
        choiceResponse({
          binding: { provider: "claude", connectionId: "team", choice: "explicit" },
          accounts: [option("team", "Team Claude", { usage })],
        }),
    });
    const view = await render(client);
    try {
      await view.open();
      expect(document.body.textContent).toContain(expected);
      expect(document.querySelector('[role="progressbar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

test("a redacted binding does not borrow another visible account's usage", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({ binding: { provider: "claude", connectionId: null, choice: "explicit" } }),
  });
  const view = await render(client);
  try {
    await view.open();
    expect(document.body.textContent).toContain("Account unavailable");
    expect(document.body.textContent).toContain("Account usage hidden");
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("retains account identity, plan, source, and the reason an inactive account is refused", async () => {
  let choices = 0;
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        binding: { provider: "claude", connectionId: "reconnect", choice: "explicit" },
        accounts: [
          option("reconnect", "Team Claude", {
            accountEmail: "team@example.test",
            planType: "Max",
            status: "needs_relogin",
            choosable: false,
            refusal: "inactive",
          }),
          option("error", "Backup Claude", {
            planType: "Pro",
            status: "error",
            choosable: false,
            refusal: "inactive",
          }),
        ],
      }),
    setSessionModelAccount: async () => {
      choices += 1;
      throw new Error("Refused accounts cannot be chosen");
    },
  });
  const view = await render(client);
  try {
    await view.open();
    expect(document.body.textContent).toContain("team@example.test");
    expect(document.body.textContent).toContain("Max · Organization · Needs reconnect");
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const reconnect = rows.find((row) => row.textContent?.includes("Team Claude"))!;
    const error = rows.find((row) => row.textContent?.includes("Backup Claude"))!;
    expect(reconnect.textContent).toContain("MaxNeeds reconnect");
    expect(reconnect.title).toContain("team@example.test");
    expect(error.textContent).toContain("ProError");
    expect(reconnect.getAttribute("aria-disabled")).toBe("true");
    expect(error.getAttribute("aria-disabled")).toBe("true");
    await act(async () => error.click());
    expect(choices).toBe(0);
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.body.textContent).not.toContain("% remaining");
    expect(document.body.textContent).toContain(
      "Applies next turn. The current turn keeps its account.",
    );
  } finally {
    await view.cleanup();
  }
});

test("shows a server selection error without claiming that the account was saved", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => choiceResponse(),
    setSessionModelAccount: async () => {
      throw new Error("Account access changed");
    },
  });
  const view = await render(client);
  try {
    await view.open();
    const mine = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent === "My Claude",
    )!;
    await act(async () => mine.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Account access changed");
    expect(document.body.textContent).not.toContain("Selection saved");
  } finally {
    await view.cleanup();
  }
});

test.each([false, true])(
  "account selection never changes personal fallback (opt-in %s)",
  async (fallbackOptIn) => {
    const calls: Array<string | null> = [];
    let preferenceCalls = 0;
    let current = choiceResponse({
      personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn },
    });
    const client = Object.assign(fakeClient({}), {
      getSessionModelAccount: async () => current,
      setSessionModelAccount: async (
        _workspaceId: string,
        _sessionId: string,
        request: { connectionId: string | null },
      ) => {
        calls.push(request.connectionId);
        const choice = request.connectionId ? ("explicit" as const) : ("automatic" as const);
        current = {
          ...current,
          binding: { provider: "claude", connectionId: request.connectionId, choice },
        };
        return {
          changed: true,
          appliedTo: "next_turn" as const,
          provider: "claude",
          connectionId: request.connectionId,
          choice,
        };
      },
      updateModelAccountPreferences: async () => {
        preferenceCalls += 1;
        throw new Error("The account picker must not change fallback preferences");
      },
    });
    const view = await render(client);
    try {
      await view.open();
      expect(menuItems()).toEqual(["Automatic", "Team Claude", "My Claude"]);
      expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
      const mine = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (row) => row.textContent === "My Claude",
      )!;
      await act(async () => mine.click());
      expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Model account · My Claude",
      );
      const automatic = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (row) => row.textContent === "Automatic",
      )!;
      await act(async () => automatic.click());
      expect(calls).toEqual(["mine-1", null]);
      expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Model account · Automatic",
      );
      expect(menuItems()).toEqual(["Automatic", "Team Claude", "My Claude"]);
      expect(preferenceCalls).toBe(0);
      expect(current.personal.fallbackOptIn).toBe(fallbackOptIn);
    } finally {
      await view.cleanup();
    }
  },
);

test("uses the displayed provider's binding and scopes Automatic to it", async () => {
  const calls: Array<{ connectionId: string | null; provider?: string }> = [];
  const bindings: SessionModelAccountChoiceResponse["bindings"] = [
    { provider: "codex", connectionId: "codex-pin", choice: "explicit" },
    { provider: "claude", connectionId: "shared-1", choice: "explicit" },
    { provider: "xai", connectionId: "xai-pin", choice: "explicit" },
  ];
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => choiceResponse({ binding: null, bindings }),
    setSessionModelAccount: async (
      _workspaceId: string,
      _sessionId: string,
      request: { connectionId: string | null; provider?: string },
    ) => {
      calls.push(request);
      return {
        changed: true,
        appliedTo: "next_turn" as const,
        provider: "claude",
        connectionId: null,
        choice: "automatic" as const,
      };
    },
  });
  const view = await render(client);
  try {
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Model account · Team Claude",
    );
    await view.open();
    const automatic = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent === "Automatic",
    )!;
    await act(async () => automatic.click());
    expect(calls).toEqual([{ connectionId: null, provider: "claude" }]);
  } finally {
    await view.cleanup();
  }
});

test("an unavailable pin with no eligible accounts can still return to Automatic", async () => {
  const calls: Array<{ connectionId: string | null; provider?: string }> = [];
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        accounts: [],
        bindings: [{ provider: "claude", connectionId: null, choice: "explicit" }],
      }),
    setSessionModelAccount: async (
      _workspaceId: string,
      _sessionId: string,
      request: { connectionId: string | null; provider?: string },
    ) => {
      calls.push(request);
      return {
        changed: true,
        appliedTo: "next_turn" as const,
        provider: "claude",
        connectionId: null,
        choice: "automatic" as const,
      };
    },
  });
  const view = await render(client);
  try {
    await view.open();
    expect(document.body.textContent).toContain("Account unavailable");
    expect(menuItems()).toEqual(["Automatic"]);
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(calls).toEqual([{ connectionId: null, provider: "claude" }]);
  } finally {
    await view.cleanup();
  }
});

test("the bound account uses the top quota and other accounts retain their own usage", async () => {
  const usage = (usedPercent: number): NonNullable<ModelAccountChoiceOption["usage"]> => ({
    observedAt: "2026-10-12T09:00:00Z",
    source: "response_headers",
    exhaustedKind: null,
    exhaustedUntil: null,
    windows: [{ id: "five_hour", usedPercent, resetsAt: null, status: "ok" }],
  });
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        bindings: [{ provider: "claude", connectionId: "shared-1", choice: "automatic" }],
        accounts: [
          option("shared-1", "Team Claude", { usage: usage(36) }),
          option("shared-2", "Other Claude", { usage: usage(74) }),
        ],
      }),
  });
  const view = await render(client);
  try {
    await view.open();
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(rows.find((row) => row.textContent?.includes("Team Claude"))!.textContent).not.toContain(
      "36%",
    );
    expect(rows.find((row) => row.textContent?.includes("Other Claude"))!.textContent).toContain(
      "74% used",
    );
    expect(document.querySelector('[aria-label="5h used"]')?.getAttribute("aria-valuenow")).toBe(
      "36",
    );
  } finally {
    await view.cleanup();
  }
});

test("hides the fallback toggle where the organization does not allow personal fallback", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () =>
      choiceResponse({
        personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
      }),
    updateModelAccountPreferences: async () => ({ personalFallbackOptIn: false, version: 0 }),
  });
  const view = await render(client);
  try {
    await view.open();
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});
