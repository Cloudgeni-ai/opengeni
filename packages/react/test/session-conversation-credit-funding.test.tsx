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

test("opening the conversation picker refreshes credit funding without closing the menu", async () => {
  let funding: "promotional" | "general" | "unavailable" = "promotional";
  let catalogCalls = 0;
  let releaseCatalog: (() => void) | undefined;
  const client = fakeClient({
    getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
    getQueue: async () =>
      ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => {
      catalogCalls++;
      if (catalogCalls > 1) {
        await new Promise<void>((resolve) => {
          releaseCatalog = resolve;
        });
      }
      return {
        models: [
          {
            id: "model-x",
            label: "Model X",
            provider: "openai",
            providerLabel: "OpenAI",
            source: "opengeni",
            api: "responses",
            cost: "credits",
            creditFunding: funding,
            credentialReadiness: { status: "ready" },
            availability: { selectable: true, reason: null },
          },
        ],
      } as never;
    },
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
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
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Model and effort"]',
    )!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).not.toContain("Free credits");
    for (const [nextFunding, hint] of [
      ["general", "Uses credits"],
      ["unavailable", "Needs credits"],
      ["promotional", "Free credits"],
    ] as const) {
      funding = nextFunding;
      const callsBefore = catalogCalls;
      await actRun(() => trigger.click());
      await waitFor(() => catalogCalls > callsBefore, "opening picker did not refresh funding");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(view.container.querySelector('[data-testid="model-picker-loading"]')).toBeNull();
      await actRun(() => releaseCatalog?.());
      await waitFor(
        () => Boolean(document.body.textContent?.includes(hint)),
        "funding hint did not update",
      );
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(trigger.textContent).not.toContain(hint);
      await actRun(() => trigger.click());
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
  } finally {
    releaseCatalog?.();
    await view.unmount();
  }
});
