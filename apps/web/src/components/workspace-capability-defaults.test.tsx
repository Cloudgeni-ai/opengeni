import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
const { WorkspaceCapabilityDefaultsView } = await import("./workspace-capability-defaults");
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

async function mount(
  custom: boolean,
  kind: "permissions" | "plugins" = "permissions",
  canManage = true,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const save = mock(async () => true);
  await act(async () =>
    root.render(
      <WorkspaceCapabilityDefaultsView
        servers={[{ id: "files", name: "Files" }]}
        firstPartyTools={[
          { id: "command_read", name: "Read command" },
          { id: "command_wait", name: "Wait for command" },
        ]}
        defaults={{ mcpServerIds: ["files"], firstPartyMcpTools: ["command_read"] }}
        custom={custom}
        revisionKey="one"
        kind={kind}
        canManage={canManage}
        onSave={save}
      />,
    ),
  );
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, save, click, cleanup };
}

test("inherited defaults never save on mount, customization or cancel", async () => {
  const view = await mount(false);
  try {
    expect(view.host.textContent).toContain("Using deployment defaults");
    expect(view.save).not.toHaveBeenCalled();
    await view.click("Customize");
    expect(view.host.textContent).toContain("Future tools will not be added automatically");
    expect(view.save).not.toHaveBeenCalled();
    await view.click("Cancel");
    expect(view.save).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test("partial groups are mixed, inspectable and saved deliberately without plugin selection", async () => {
  const view = await mount(true);
  try {
    expect(view.host.textContent).toContain("1 of 2 enabled · Partially enabled");
    const mixed = view.host.querySelector<HTMLInputElement>('input[aria-checked="mixed"]')!;
    expect(mixed.indeterminate).toBe(true);
    expect(mixed.checked).toBe(false);
    expect(mixed.disabled).toBe(true);
    await view.click("Edit selection");
    await act(async () => mixed.click());
    await view.click("Save custom selection");
    expect(view.save).toHaveBeenCalledWith({
      firstPartyMcpTools: ["command_read", "command_wait"],
    });
  } finally {
    await view.cleanup();
  }
});

test("reset requires confirmation and removes only the selected override", async () => {
  const view = await mount(true);
  try {
    await view.click("Use deployment defaults");
    expect(view.save).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("This may enable tools");
    await view.click("Use deployment defaults");
    expect(view.save).toHaveBeenCalledWith({ firstPartyMcpTools: null });
  } finally {
    await view.cleanup();
  }
});

test("saving plugin defaults does not write a built-in tools override", async () => {
  const view = await mount(false, "plugins");
  try {
    await view.click("Customize");
    await view.click("Save custom selection");
    expect(view.save).toHaveBeenCalledWith({ mcpServerIds: ["files"] });
  } finally {
    await view.cleanup();
  }
});

test("workspace readers cannot customize or reset", async () => {
  const view = await mount(true, "permissions", false);
  try {
    await view.click("Use deployment defaults");
    await view.click("Edit selection");
    expect(view.save).not.toHaveBeenCalled();
    expect(view.host.textContent).not.toContain("Remove this override?");
  } finally {
    await view.cleanup();
  }
});
