import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { VoiceInputPreferences } from "./transcription-settings";
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
test("provider selection and toggles preserve the other workspace preferences", async () => {
  const writes: unknown[] = [];
  const context = {
    workspaces: [
      {
        id: "workspace",
        settings: {
          voiceInput: {
            enabled: true,
            preferredProvider: "codex-subscription",
            fallbackEnabled: false,
          },
        },
      },
    ],
    clientConfig: {
      voiceInput: { available: true, providers: ["supergrok-subscription", "codex-subscription"] },
    },
    captureWorkspaceInvocation: () => ({}),
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async (_id: string, patch: unknown) => {
      writes.push(patch);
      return {};
    },
  } as unknown as ComponentProps<typeof VoiceInputPreferences>["context"];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<VoiceInputPreferences workspaceId="workspace" canManage context={context} />),
    );
    const select = container.querySelector("select")!;
    expect(select.value).toBe("codex-subscription");
    expect(select.textContent).toContain("SuperGrok subscription");
    await act(async () => {
      select.value = "supergrok-subscription";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(writes[0]).toEqual({
      voiceInput: {
        enabled: true,
        preferredProvider: "supergrok-subscription",
        fallbackEnabled: false,
      },
    });
    await act(async () => {
      (container.querySelector('[aria-label="Voice input"]') as HTMLButtonElement).click();
    });
    expect(writes[1]).toEqual({
      voiceInput: {
        enabled: false,
        preferredProvider: "codex-subscription",
        fallbackEnabled: false,
      },
    });
    await act(async () =>
      root.render(
        <VoiceInputPreferences workspaceId="workspace" canManage={false} context={context} />,
      ),
    );
    expect(select.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
