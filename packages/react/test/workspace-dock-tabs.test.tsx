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
  test("optional tabs live in the one menu, which names the open one", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-optional"
        essentials
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
    const menu = () => rendered.container.querySelector<HTMLElement>("[data-dock-menu]");
    expect(menu()).not.toBeNull();
    expect(menu()?.getAttribute("data-dock-menu-active")).toBeNull();
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
    // Opening Files keeps the strip at its essentials; the menu shows Files.
    expect(shown()).toEqual(["Changes"]);
    expect(menu()?.getAttribute("data-dock-menu-active")).toBe("files");
    expect(rendered.container.textContent ?? "").toContain("Files content");

    await click(rendered.container.querySelector('[role="tab"][aria-label="Changes"]'));
    await flush();
    expect(menu()?.getAttribute("data-dock-menu-active")).toBeNull();
    await rendered.unmount();
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
