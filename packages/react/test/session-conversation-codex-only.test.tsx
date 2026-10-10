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

const catalogModel = (id: string, label: string, provider: string, source: string) => ({
  id,
  label,
  provider,
  providerLabel: provider,
  source,
  api: "responses",
  cost: "credits",
  credentialReadiness: { status: "ready" },
  availability: { selectable: true, reason: null },
});

for (const mode of ["remote_v2", "portable"] as const) {
  test(`the default conversation picker ${mode === "remote_v2" ? "disables" : "offers"} other providers in a ${mode} session`, async () => {
    const client = fakeClient({
      getSession: async () =>
        ({ id: SESSION_ID, status: "idle", codexCompactionMode: mode }) as never,
      getQueue: async () =>
        ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
      getWorkspaceModelCatalog: async () =>
        ({
          models: [
            catalogModel("codex/gpt-5.6-sol", "GPT-5.6 Sol", "codex", "codex"),
            catalogModel("claude/opus", "Claude Opus", "anthropic", "opengeni"),
          ],
        }) as never,
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
      await actRun(() => trigger.click());
      const choice = (id: string) =>
        document.querySelector<HTMLButtonElement>(`[data-testid="model-picker-choice-${id}"]`);
      await waitFor(() => choice("claude/opus") !== null, "picker rows did not render");
      expect(choice("codex/gpt-5.6-sol")!.disabled).toBe(false);
      expect(choice("claude/opus")!.disabled).toBe(mode === "remote_v2");
      expect(choice("claude/opus")!.textContent?.includes("Codex-only session")).toBe(
        mode === "remote_v2",
      );
    } finally {
      await view.unmount();
    }
  });
}
