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
const RESTRICTED = [
  { id: "code_search", available: false, unavailableReason: "region_restricted" },
];
// One stable context, as the app's is.
const context = {
  workspaces: [{ id: WORKSPACE_ID, settings: { codeSearchEnabled: true } }],
  clientConfig: {
    codeSearch: { available: true, workspaceDefault: "off" } as
      | { available: boolean; workspaceDefault: string }
      | undefined,
    inferenceFeatures: [] as unknown[],
  },
  captureWorkspaceInvocation: () => null,
  ownsWorkspaceInvocation: () => false,
  updateWorkspaceSettings: async () => null,
};
mock.module("@opengeni/react/app/app-context", () => ({
  ...ContextModule,
  useAppContext: () => context,
}));
const { CodeSearchPreferenceRow } = await import("./workspace-settings");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  context.clientConfig.codeSearch = { available: true, workspaceDefault: "off" };
  context.clientConfig.inferenceFeatures = [];
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CodeSearchPreferenceRow workspaceId={WORKSPACE_ID} canManage />);
  });
  return { container, root };
}

function checked(container: HTMLElement) {
  return container.querySelector(
    '[role="radio"][aria-checked="true"], [aria-pressed="true"], [data-state="on"]',
  )?.textContent;
}

test("offered here but EU-only: Not supported in EU, Off, and nothing can be chosen", async () => {
  context.clientConfig.inferenceFeatures = RESTRICTED;
  const { container, root } = await render();
  expect(container.textContent).toContain("Fast code search");
  expect(container.textContent).toContain("Not supported in EU");
  expect(checked(container)).toBe("Off");
  const options = [...container.querySelectorAll<HTMLButtonElement>("button")];
  expect(options.length).toBeGreaterThan(0);
  expect(options.every((option) => option.disabled)).toBe(true);
  await act(async () => root.unmount());
});

test("not offered by the deployment: no row, and never Not supported in EU", async () => {
  context.clientConfig.codeSearch = { available: false, workspaceDefault: "off" };
  context.clientConfig.inferenceFeatures = RESTRICTED;
  const { container, root } = await render();
  expect(container.textContent).toBe("");
  await act(async () => root.unmount());
});

test("outside EU-only the saved choice shows and can be changed", async () => {
  const { container, root } = await render();
  expect(container.textContent).not.toContain("Not supported in EU");
  expect(checked(container)).toBe("On");
  await act(async () => root.unmount());
});
