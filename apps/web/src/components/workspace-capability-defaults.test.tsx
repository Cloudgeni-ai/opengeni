import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
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
  overrides: Partial<ComponentProps<typeof WorkspaceCapabilityDefaultsView>> = {},
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
        {...overrides}
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
    expect(view.host.textContent).toContain("Nothing changes until you save");
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
    expect(view.save).toHaveBeenCalledWith({
      mcpServerIds: ["files"],
      inheritConnectedMcpServers: false,
    });
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

test("built-in controls preserve hidden connector selections and automatic inheritance", async () => {
  const view = await mount(false, "permissions", true, {
    servers: [
      { id: "files", name: "Files" },
      { id: "slack", name: "Slack connection" },
    ],
    firstPartyTools: [
      { id: "command_read", name: "Read command" },
      { id: "slack_bot_search", name: "Slack search" },
    ],
    defaults: {
      mcpServerIds: ["files", "slack", "temporarily-unavailable"],
      firstPartyMcpTools: ["command_read", "slack_bot_search"],
      inheritConnectedMcpServers: true,
    },
  });
  try {
    expect(view.host.textContent).not.toContain("Slack");
    expect(view.host.textContent).toContain("Command output");
    await view.click("Customize");
    const files = [...view.host.querySelectorAll("label")]
      .find((label) => label.textContent === "Files")!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => files.click());
    await view.click("Save custom selection");
    expect(view.save).toHaveBeenCalledWith({
      firstPartyMcpTools: ["command_read", "slack_bot_search"],
      mcpServerIds: ["slack", "temporarily-unavailable"],
      inheritConnectedMcpServers: true,
    });
  } finally {
    await view.cleanup();
  }
});

test("switching to an exact connector list starts from current apps without touching native tools", async () => {
  const view = await mount(true, "plugins", true, {
    servers: [
      { id: "files", name: "Files" },
      { id: "slack", name: "Slack connection" },
      { id: "linear", name: "New Linear connection" },
    ],
    defaults: {
      mcpServerIds: ["files", "slack"],
      firstPartyMcpTools: ["command_read"],
      inheritConnectedMcpServers: true,
    },
  });
  try {
    expect(view.host.textContent).not.toContain("Command output");
    expect(view.host.textContent).not.toContain("Slack connection");
    await view.click("Edit selection");
    const automatic = [...view.host.querySelectorAll("label")]
      .find((label) => label.textContent === "Use connected apps automatically")!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => automatic.click());
    expect(view.host.textContent).toContain("New Linear connection");
    await view.click("Save custom selection");
    expect(view.save).toHaveBeenCalledWith({
      mcpServerIds: ["files", "linear", "slack"],
      inheritConnectedMcpServers: false,
    });
  } finally {
    await view.cleanup();
  }
});

test("resetting built-in tools re-enables native carriers without widening an exact connector list", async () => {
  const view = await mount(true, "permissions", true, {
    defaults: { mcpServerIds: [], firstPartyMcpTools: ["command_read"] },
  });
  try {
    await view.click("Use deployment defaults");
    await view.click("Use deployment defaults");
    expect(view.save).toHaveBeenCalledWith({ firstPartyMcpTools: null, mcpServerIds: ["files"] });
  } finally {
    await view.cleanup();
  }
});
