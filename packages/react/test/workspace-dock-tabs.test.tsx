import { describe, expect, mock, test } from "bun:test";
import { flush, registerDom, renderComponent } from "./render-hook";
import { dropdownMenuStub } from "./dropdown-menu-stub";

registerDom();

mock.module("../src/ui/dropdown-menu", dropdownMenuStub);

const { act } = await import("react");
const { WorkspaceDock } = await import("../src/components/workspace-dock");

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const TABS = [
  { id: "changes", label: "Changes", content: <div>Changes content</div> },
  { id: "files", label: "Files", optional: true, content: <div>Files content</div> },
  { id: "terminal", label: "Terminal", optional: true, content: <div>Terminal content</div> },
];

describe("WorkspaceDock tab strip", () => {
  test("an opened optional tab joins the strip until it is closed", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-optional"
        essentials
        tabScope="chat-a"
        primary={<div>Chat pane</div>}
        tabs={TABS}
      />,
    );
    const shown = () =>
      [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        tab.getAttribute("aria-label"),
      );
    expect(shown()).toEqual(["Changes"]);
    expect(
      rendered.container.querySelector('[role="tablist"]')?.getAttribute("aria-orientation"),
    ).toBe("horizontal");
    expect(rendered.container.querySelector("[data-dock-menu]")).not.toBeNull();
    const menuTabs = () =>
      [...rendered.container.querySelectorAll<HTMLElement>("[data-dock-menu-tab]")].map((item) =>
        item.getAttribute("data-dock-menu-tab"),
      );
    expect(menuTabs()).toEqual(["files", "terminal"]);
    const actions = [
      ...rendered.container.querySelectorAll<HTMLElement>("[data-dock-menu-action]"),
    ].map((item) => item.getAttribute("data-dock-menu-action"));
    expect(actions).toEqual(["maximize", "hide"]);

    await click(rendered.container.querySelector('[data-dock-menu-tab="files"]'));
    await flush();
    // Files is on the strip now, selected, and out of the "+" menu.
    expect(shown()).toEqual(["Changes", "Files"]);
    expect(menuTabs()).toEqual(["terminal"]);
    expect(
      rendered.container
        .querySelector('[role="tab"][aria-label="Files"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(rendered.container.textContent ?? "").toContain("Files content");

    // It stays while the person looks at another tab.
    await click(rendered.container.querySelector('[role="tab"][aria-label="Changes"]'));
    await flush();
    expect(shown()).toEqual(["Changes", "Files"]);

    // Closing it puts it back in the menu.
    await click(rendered.container.querySelector('[data-dock-tab-close="files"]'));
    await flush();
    expect(shown()).toEqual(["Changes"]);
    expect(menuTabs()).toEqual(["files", "terminal"]);
    await rendered.unmount();
  });

  test("closing the open tab selects its neighbour, and opened tabs are kept per scope", async () => {
    const dock = (scope: string) => (
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-scope"
        essentials
        tabScope={scope}
        primary={<div>Chat pane</div>}
        tabs={TABS}
      />
    );
    const first = await renderComponent(dock("chat-b"));
    await click(first.container.querySelector('[data-dock-menu-tab="terminal"]'));
    await flush();
    await first.unmount();

    // Back in the same chat: Terminal is still on the strip.
    const again = await renderComponent(dock("chat-b"));
    const shown = () =>
      [...again.container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        tab.getAttribute("aria-label"),
      );
    expect(shown()).toEqual(["Changes", "Terminal"]);
    await click(again.container.querySelector('[role="tab"][aria-label="Terminal"]'));
    await flush();
    await click(again.container.querySelector('[data-dock-tab-close="terminal"]'));
    await flush();
    expect(shown()).toEqual(["Changes"]);
    expect(
      again.container
        .querySelector('[role="tab"][aria-label="Changes"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    await again.unmount();

    // Another chat starts with only what is relevant.
    const other = await renderComponent(dock("chat-c"));
    expect(
      [...other.container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        tab.getAttribute("aria-label"),
      ),
    ).toEqual(["Changes"]);
    await other.unmount();
  });

  test("without essentials the dock keeps its own buttons", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-default"
        primary={<div>Chat pane</div>}
        tabs={TABS}
      />,
    );
    expect(rendered.container.querySelectorAll("[data-dock-menu-action]").length).toBe(0);
    await rendered.unmount();
  });
});
