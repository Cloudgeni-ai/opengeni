import { expect, test } from "bun:test";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { SessionConversation } = await import("../src/components/session-conversation");

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await flush(10);
  }
}

function conversationClient(models: unknown[]) {
  return fakeClient({
    getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
    getQueue: async () =>
      ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => ({ models }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
}

test("a published Site host's bare model rows render in the picker instead of crashing", async () => {
  // Published Site hosts before the fix answered the catalog with `{ id }` only.
  const client = conversationClient([{ id: "gpt-5.6-sol" }]);
  const view = await renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      modelPicker
    />,
  );
  try {
    await flush(150);
    expect(view.container.querySelector("[data-og-conversation-render-error]")).toBeNull();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Model and effort"]',
    )!;
    expect(trigger).not.toBeNull();
    await actRun(() => trigger.click());
    const choice = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="model-picker-choice-gpt-5.6-sol"]');
    await waitFor(() => choice() !== null, "bare row did not render");
    expect(choice()!.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

test("a chat rendering error stays inside the chat and leaves the host page mounted", async () => {
  const client = conversationClient([null]);
  const originalError = console.error;
  console.error = () => {};
  const view = await renderComponent(
    <div>
      <p data-testid="host-content">Dashboard</p>
      <SessionConversation
        sessionId={SESSION_ID}
        client={client}
        workspaceId={WORKSPACE_ID}
        modelPicker
      />
    </div>,
  );
  try {
    await waitFor(
      () => view.container.querySelector("[data-og-conversation-render-error]") !== null,
      "render error fallback did not appear",
    );
    expect(view.container.querySelector('[data-testid="host-content"]')?.textContent).toBe(
      "Dashboard",
    );
    expect(view.container.textContent).toContain("This chat couldn't be displayed.");
  } finally {
    console.error = originalError;
    await view.unmount();
  }
});
