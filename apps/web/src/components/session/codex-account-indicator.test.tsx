import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
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
const { CodexAccountIndicator } = await import("./codex-account-indicator");
afterAll(() => GlobalRegistrator.unregister());

test("shows the blocked account instead of a healthy default and permits repeating Auto", async () => {
  const calls: string[] = [];
  const client = Object.assign(fakeClient({}), {
    getSession: async () => ({
      codexPinnedCredentialId: null,
      codexCurrentSelection: { credentialId: "blocked", waiting: true },
    }),
    listCodexAccounts: async () => ({
      accounts: [
        {
          id: "blocked",
          label: "Blocked account",
          status: "active",
          plan: "pro",
          allocatorEnabled: true,
        },
        {
          id: "healthy",
          label: "Healthy default",
          status: "active",
          plan: "pro",
          allocatorEnabled: true,
        },
      ],
      activeAccountId: "healthy",
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: "healthy",
      },
    }),
    pinSessionCodexAccount: async (_workspace: string, _session: string, target: string) => {
      calls.push(target);
      return { pinned: target, appliedTo: "waiting_turn" };
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <CodexAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="session"
            model="codex/gpt-5.6-sol"
            events={[]}
          />
        </OpenGeniProvider>,
      ),
    );
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toContain("Waiting for capacity · Blocked account");
    await act(async () =>
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
      ),
    );
    expect(document.body.textContent).toContain("Retry with");
    const auto = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Auto"),
    );
    expect(auto).toBeDefined();
    await act(async () => auto!.click());
    expect(calls).toEqual(["auto"]);
    expect(document.body.textContent).toContain("Selection saved. Capacity is being rechecked.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
