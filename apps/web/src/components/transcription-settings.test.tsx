import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentProps } from "react";

// Register the DOM before React DOM and Radix load, so the select's menu mounts.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { VoiceInputPreferences } = await import("./transcription-settings");
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
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toContain("Codex subscription");
    await act(async () => trigger.click());
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
    // "Automatic" names the first provider as its payer, so pick the provider's own option.
    const supergrok = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) =>
        option.textContent?.includes("SuperGrok subscription") &&
        !option.textContent.includes("Automatic"),
    )!;
    await act(async () => supergrok.click());
    expect(writes[0]).toEqual({
      voiceInput: {
        enabled: true,
        preferredProvider: "supergrok-subscription",
        fallbackEnabled: false,
      },
    });
    const voiceSwitch = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')][0]!;
    await act(async () => voiceSwitch.click());
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
    expect(
      container.querySelector<HTMLButtonElement>('[role="combobox"]')!.disabled ||
        container.querySelector('[role="combobox"]')!.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
