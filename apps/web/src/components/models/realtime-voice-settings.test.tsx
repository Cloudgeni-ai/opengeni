import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceRealtimeModelCatalogItem } from "@opengeni/sdk";

// Register the DOM before React DOM and Radix load.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const WORKSPACE_ID = "workspace-voice";
const ELEVEN = "workspace-elevenlabs/eleven_realtime_v1_max";

let models: WorkspaceRealtimeModelCatalogItem[] = [];
const updateWorkspaceSettings = mock(async (_workspaceId: string, _patch: unknown) => ({}));
const context = {
  client: {
    getWorkspaceRealtimeModelCatalog: async () => ({ models }),
    updateWorkspaceSettings,
  },
};
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
}));

const { OrganizationRealtimeVoiceSettingsRows, RealtimeVoiceSettingsRows } =
  await import("./realtime-voice-settings");

function catalogModel(
  overrides: Partial<WorkspaceRealtimeModelCatalogItem> &
    Pick<WorkspaceRealtimeModelCatalogItem, "id">,
): WorkspaceRealtimeModelCatalogItem {
  return {
    label: overrides.id,
    provider: "Your Gateway",
    description: "Voice",
    available: true,
    unavailableReason: null,
    recommended: false,
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  updateWorkspaceSettings.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

async function settle() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

test("lists the voice settings of each available model that offers some, and saves a custom voice id", async () => {
  models = [
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      provider: "Your ElevenLabs",
      languages: ["en", "no", "sv"],
      voices: [
        { id: "brian", label: "Brian" },
        { id: "lily", label: "Lily" },
      ],
      customVoice: true,
      turnEagerness: ["low", "medium", "high"],
      voiceDefaults: { voice: "brian", turnEagerness: "high" },
      workspaceVoiceSettings: { voice: "my-voices-id", language: "no" },
    }),
    catalogModel({
      id: "workspace-gateway/openai/gpt-realtime-mini",
      label: "GPT Realtime Mini",
      voices: [{ id: "marin", label: "Marin" }],
    }),
    // Nothing to choose, or not usable here: not listed.
    catalogModel({ id: "gpt-live-1-boulder-alpha", label: "Codex Live" }),
    catalogModel({
      id: "workspace-gateway/openai/gpt-realtime-2.1",
      label: "GPT Realtime 2.1",
      voices: [{ id: "marin", label: "Marin" }],
      available: false,
      unavailableReason: "Connect a workspace AI Gateway key",
    }),
  ];
  await act(async () =>
    root.render(<RealtimeVoiceSettingsRows workspaceId={WORKSPACE_ID} canManage />),
  );
  await settle();
  const text = container.textContent ?? "";
  expect(text).toContain("Eleven Realtime v1 max");
  expect(text).toContain("Voice: my-voices-id · Norwegian · Quick turn-taking");
  expect(text).toContain("GPT Realtime Mini");
  expect(text).toContain("Default voice");
  expect(text).not.toContain("Codex Live");
  expect(text).not.toContain("GPT Realtime 2.1");

  const edit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  )!;
  await act(async () => edit.click());
  await settle();
  // A saved voice that isn't listed opens as "Another voice by ID", with its id filled in.
  expect(document.body.textContent).toContain("Another voice by ID");
  const voiceInput = document.querySelector<HTMLInputElement>('input[value="my-voices-id"]')!;
  expect(voiceInput).not.toBeNull();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(voiceInput, "other-voices-id");
    voiceInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());
  await settle();
  expect(updateWorkspaceSettings).toHaveBeenCalledTimes(1);
  expect(updateWorkspaceSettings.mock.calls[0]).toEqual([
    WORKSPACE_ID,
    {
      realtimeVoice: { [ELEVEN]: { voice: "other-voices-id", language: "no" } },
    },
  ]);
});

test("shows the settings read-only to people who cannot change them", async () => {
  models = [
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      customVoice: true,
      voiceDefaults: { voice: "brian" },
    }),
  ];
  await act(async () =>
    root.render(<RealtimeVoiceSettingsRows workspaceId={`${WORKSPACE_ID}-2`} canManage={false} />),
  );
  await settle();
  expect(container.textContent).toContain("Voice: Brian (default)");
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(
    false,
  );
});

test("a workspace without its own settings shows and starts from the organization's default", async () => {
  models = [
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      voices: [
        { id: "brian", label: "Brian" },
        { id: "lily", label: "Lily" },
      ],
      voiceDefaults: { voice: "brian" },
      organizationVoiceSettings: { voice: "lily" },
    }),
  ];
  await act(async () =>
    root.render(
      <RealtimeVoiceSettingsRows
        workspaceId={`${WORKSPACE_ID}-3`}
        canManage
        organizationName="Acme"
      />,
    ),
  );
  await settle();
  expect(container.textContent).toContain("Voice: Lily · Acme's default");
  // Nothing of its own to reset yet.
  expect(container.querySelector('[aria-label="More actions for Eleven Realtime v1 max"]')).toBe(
    null,
  );
  const edit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
  await act(async () => edit.click());
  await settle();
  const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => save.click());
  await settle();
  // Saving keeps what it showed, now as the workspace's own.
  expect(updateWorkspaceSettings.mock.calls[0]).toEqual([
    `${WORKSPACE_ID}-3`,
    { realtimeVoice: { [ELEVEN]: { voice: "lily" } } },
  ]);
});

test("the organization's defaults save through the organization, not a workspace", async () => {
  models = [
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      languages: ["en", "no"],
      voiceDefaults: { voice: "brian" },
    }),
  ];
  const update = mock(async (_request: unknown) => ({}) as never);
  const defaults = {
    defaults: {
      sessionDefaults: null,
      allowedProviders: null,
      allowedModels: null,
      modelCompactionThresholds: {},
      realtimeVoice: { [ELEVEN]: { language: "no" } },
      realtimeDefaultModel: null,
      updatedAt: null,
    },
    loading: false,
    error: null,
    reload: async () => undefined,
    update,
  };
  await act(async () =>
    root.render(
      <OrganizationRealtimeVoiceSettingsRows
        anchorWorkspaceId={`${WORKSPACE_ID}-4`}
        defaults={defaults}
      />,
    ),
  );
  await settle();
  expect(container.textContent).toContain("Norwegian");
  expect(container.textContent).not.toContain("default ·");
  const more = container.querySelector<HTMLButtonElement>(
    '[aria-label="More actions for Eleven Realtime v1 max"]',
  );
  expect(more).not.toBeNull();
  const edit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
  await act(async () => edit.click());
  await settle();
  expect(document.body.textContent).toContain("every workspace that hasn't chosen its own");
  const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => save.click());
  await settle();
  expect(update.mock.calls[0]).toEqual([{ realtimeVoice: { [ELEVEN]: { language: "no" } } }]);
  expect(updateWorkspaceSettings).not.toHaveBeenCalled();
});

test("a workspace shows its organization's default voice model and can choose its own", async () => {
  const MINI = "workspace-elevenlabs/eleven_realtime_v1_mini";
  models = [
    catalogModel({
      id: "gpt-live-1-boulder-alpha",
      label: "Codex Live",
      provider: "Connected Codex",
    }),
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      provider: "Your ElevenLabs",
      organizationDefault: true,
    }),
    catalogModel({
      id: MINI,
      label: "Eleven Realtime v1 mini",
      provider: "Your ElevenLabs",
    }),
  ];
  await act(async () =>
    root.render(
      <RealtimeVoiceSettingsRows
        workspaceId={`${WORKSPACE_ID}-5`}
        canManage
        organizationName="Acme"
      />,
    ),
  );
  await settle();
  expect(container.textContent).toContain("Default voice model");
  const trigger = container.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="Default voice model"]',
  );
  expect(trigger).not.toBeNull();
  // Following the organization: its choice is named on the trigger.
  expect(trigger!.textContent).toContain("Acme's default");
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger!.click();
  });
  await settle();
  expect(document.body.textContent).toContain("Eleven Realtime v1 max");
  const mini = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("Eleven Realtime v1 mini"),
  );
  expect(mini).not.toBeUndefined();
  await act(async () => mini!.click());
  await settle();
  expect(updateWorkspaceSettings.mock.calls[0]).toEqual([
    `${WORKSPACE_ID}-5`,
    { realtimeDefaultModel: MINI },
  ]);
});

test("the organization's default voice model saves through the organization", async () => {
  models = [
    catalogModel({ id: "gpt-live-1-boulder-alpha", label: "Codex Live" }),
    catalogModel({
      id: ELEVEN,
      label: "Eleven Realtime v1 max",
      organizationDefault: true,
    }),
  ];
  const update = mock(async (_request: unknown) => ({}) as never);
  const defaults = {
    defaults: {
      sessionDefaults: null,
      allowedProviders: null,
      allowedModels: null,
      modelCompactionThresholds: {},
      realtimeVoice: {},
      realtimeDefaultModel: ELEVEN,
      updatedAt: null,
    },
    loading: false,
    error: null,
    reload: async () => undefined,
    update,
  };
  await act(async () =>
    root.render(
      <OrganizationRealtimeVoiceSettingsRows
        anchorWorkspaceId={`${WORKSPACE_ID}-6`}
        defaults={defaults}
      />,
    ),
  );
  await settle();
  const trigger = container.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="Default voice model"]',
  );
  expect(trigger!.textContent).toContain("Eleven Realtime v1 max");
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger!.click();
  });
  await settle();
  const automatic = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.startsWith("Automatic"),
  );
  expect(automatic).not.toBeUndefined();
  await act(async () => automatic!.click());
  await settle();
  expect(update.mock.calls[0]).toEqual([{ realtimeDefaultModel: null }]);
  expect(updateWorkspaceSettings).not.toHaveBeenCalled();
});
