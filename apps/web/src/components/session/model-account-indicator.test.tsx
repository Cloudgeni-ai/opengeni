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
    accounts: [
      option("shared-1", "Team Claude"),
      option("mine-1", "My Claude", { personal: true, source: "personal" }),
      option("other-provider", "Team Codex", { provider: "codex" }),
    ],
    personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn: false },
    ...overrides,
  };
}

async function render(client: ReturnType<typeof fakeClient>) {
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
          provider="claude"
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
    expect(items.some((item) => item.includes("Team Claude"))).toBe(true);
    expect(items.some((item) => item.includes("My Claude"))).toBe(true);
    expect(items.some((item) => item.includes("Team Codex"))).toBe(false);
    expect(document.body.textContent).toContain("Your accounts");
    expect(items.some((item) => item.includes("Fall back to my account"))).toBe(true);
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
    expect(mine.textContent).toContain("Private chats only");
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    const team = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
      row.textContent?.includes("Team Claude"),
    )!;
    await act(async () => team.click());
    expect(calls).toEqual(["shared-1"]);
    expect(document.body.textContent).toContain("Saved for the next turn.");
    expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Model account · Team Claude",
    );
  } finally {
    await view.cleanup();
  }
});

test("the fallback toggle changes only the caller's own opt-in", async () => {
  const updates: Array<{ organizationId: string; optIn: boolean }> = [];
  let current = choiceResponse();
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => current,
    updateModelAccountPreferences: async (
      organizationId: string,
      request: { personalFallbackOptIn: boolean },
    ) => {
      updates.push({ organizationId, optIn: request.personalFallbackOptIn });
      current = {
        ...current,
        personal: { ...current.personal, fallbackOptIn: request.personalFallbackOptIn },
      };
      return { personalFallbackOptIn: request.personalFallbackOptIn, version: 1 };
    },
  });
  const view = await render(client);
  try {
    await view.open();
    const toggle = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(updates).toEqual([{ organizationId: ORG, optIn: true }]);
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
