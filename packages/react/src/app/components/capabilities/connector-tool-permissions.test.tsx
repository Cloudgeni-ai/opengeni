import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const calls: string[] = [];
let failure: unknown = null;
mock.module("../../app-context", () => ({ useAppContext: () => ({ client }) }));
const client = {
  getConnectorToolPermissions: async (
    _workspace: string,
    _capability: string,
    input: { connectionId?: string | undefined },
  ) => {
    calls.push(input.connectionId ?? "default");
    if (failure) throw failure;
    return {
      connectionId: input.connectionId,
      accountLabel: "Selected account",
      defaultPermission: "ask",
      canManage: true,
      tools: [],
      accounts: [
        { connectionId: "first", label: "First" },
        { connectionId: "second", label: "Second" },
      ],
    };
  },
};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectorToolPermissions } = await import("./connector-tool-permissions");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function mount(connectionId = "first") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (id: string) =>
    act(async () => {
      root.render(
        <ConnectorToolPermissions workspaceId="workspace" capabilityId="slack" connectionId={id} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  await render(connectionId);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an account detail uses its exact identity and changes scope when another account opens", async () => {
  calls.length = 0;
  failure = null;
  const view = await mount();
  try {
    expect(calls).toEqual(["first"]);
    expect(view.container.querySelector('[aria-label="Account for tool permissions"]')).toBeNull();
    await view.render("second");
    expect(calls).toEqual(["first", "second"]);
  } finally {
    await view.close();
  }
});

test("missing credentials explain setup while a discovery failure keeps Retry", async () => {
  failure = { details: { code: "connector_connection_required" } };
  const missing = await mount();
  try {
    expect(missing.container.textContent).toContain("Connect or reconnect an account above");
    expect(missing.container.textContent).not.toContain("Retry loading tools");
  } finally {
    await missing.close();
  }
  failure = new Error("Temporary provider outage");
  const outage = await mount();
  try {
    expect(outage.container.textContent).toContain("Retry loading tools");
  } finally {
    await outage.close();
    failure = null;
  }
});
