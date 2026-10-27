import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before React DOM loads.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const ContextModule = await import("@opengeni/react/app/app-context");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
/** Video was on before the workspace became EU-only. */
const settings = {
  schemaVersion: 1,
  policy: { enabledModelIds: ["bytedance/seedance-2.5"], fundingSource: "workspace_gateway" },
  fundingOptions: [
    {
      source: "workspace_gateway",
      label: "AI Gateway",
      description: "This workspace's key",
      available: true,
      unavailableReason: null,
    },
  ],
  availableModels: [],
  capabilities: null,
};
// One stable context, as the app's is: a new client each render would reload.
const context = {
  client: { getVideoGenerationSettings: async () => settings },
  clientConfig: { inferenceFeatures: [] as unknown[] },
};
mock.module("@opengeni/react/app/app-context", () => ({
  ...ContextModule,
  useAppContext: () => context,
}));
const { VideoGenerationPreferenceRow } = await import("./video-generation-settings");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  context.clientConfig.inferenceFeatures = [];
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <VideoGenerationPreferenceRow workspaceId={WORKSPACE_ID} canManage refreshKey={0} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  return { container, root, toggle };
}

test("video that was on shows Not supported in EU and is switched off in an EU-only workspace", async () => {
  context.clientConfig.inferenceFeatures = [
    { id: "video_generation", available: false, unavailableReason: "region_restricted" },
  ];
  const { container, root, toggle } = await render();
  expect(container.textContent).toContain("Not supported in EU");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled || toggle.getAttribute("aria-disabled") === "true").toBe(true);
  expect(container.textContent).not.toContain("Connect AI Gateway");
  await act(async () => root.unmount());
});

test("outside EU-only the same video setting stays on and can be changed", async () => {
  const { container, root, toggle } = await render();
  expect(container.textContent).not.toContain("Not supported in EU");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(false);
  await act(async () => root.unmount());
});
