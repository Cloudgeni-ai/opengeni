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

  test("with nothing to show, the empty view offers tabs until one is picked", async () => {
    const { useState } = await import("react");
    const EMPTY_TABS = TABS.map((tab) => ({ ...tab, optional: true }));
    function Host() {
      const [landing, setLanding] = useState(true);
      return (
        <WorkspaceDock
          autoSaveId="og.test.workspace-dock-landing"
          essentials
          tabScope="chat-landing"
          landing={landing}
          onStripEmptied={() => setLanding(true)}
          onActiveTabChange={() => setLanding(false)}
          primary={<div>Chat pane</div>}
          tabs={EMPTY_TABS}
        />
      );
    }
    const rendered = await renderComponent(<Host />);
    const shown = () =>
      [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        tab.getAttribute("aria-label"),
      );
    expect(rendered.container.querySelector("[data-dock-landing]")).not.toBeNull();
    expect(shown()).toEqual([]);
    expect(rendered.container.textContent).not.toContain("Changes content");
    // "+" stays reachable on the empty view, so nothing is hidden there.
    expect(rendered.container.querySelector("[data-dock-menu]")).not.toBeNull();

    await click(rendered.container.querySelector('[data-dock-landing-tab="terminal"]'));
    await flush();
    expect(rendered.container.querySelector("[data-dock-landing]")).toBeNull();
    expect(shown()).toEqual(["Terminal"]);

    // Closing the last tab goes back to the empty view.
    await click(rendered.container.querySelector('[data-dock-tab-close="terminal"]'));
    await flush();
    expect(rendered.container.querySelector("[data-dock-landing]")).not.toBeNull();
    expect(shown()).toEqual([]);
    await rendered.unmount();
  });

  test("optional tabs show on the strip while they fit, the rest stay in +", async () => {
    // Laid out: each tab 80px wide; the header's room is set per case.
    let headerWidth = 300;
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute("data-dock-tab-measure")) return 80;
        if (this.hasAttribute("data-dock-menu")) return 28;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return [...this.children].some((child) => child.hasAttribute("data-dock-tab-measures"))
          ? headerWidth
          : 0;
      },
    });
    try {
      const tabs = [
        ...TABS,
        { id: "browser", label: "Browser", optional: true, content: <div>Browser content</div> },
        {
          id: "debug",
          label: "Debug",
          optional: true,
          inMenu: true,
          content: <div>Debug content</div>,
        },
      ];
      const view = (scope: string) => (
        <WorkspaceDock
          autoSaveId="og.test.workspace-dock-fill"
          essentials
          tabScope={scope}
          primary={<div>Chat pane</div>}
          tabs={tabs}
        />
      );
      let rendered = await renderComponent(view("fill-a"));
      await flush();
      const shown = () =>
        [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
          tab.getAttribute("aria-label"),
        );
      const menuTabs = () =>
        [...rendered.container.querySelectorAll<HTMLElement>("[data-dock-menu-tab]")].map((item) =>
          item.getAttribute("data-dock-menu-tab"),
        );
      // 300 less the 28px "+" leaves room for three tabs (80 + 82 + 82), not four.
      expect(shown()).toEqual(["Changes", "Files", "Terminal"]);
      expect(menuTabs()).toEqual(["browser", "debug"]);
      // A tab there by room has no close button: closing would only bring it back.
      expect(rendered.container.querySelector('[data-dock-tab-close="files"]')).toBeNull();
      await rendered.unmount();

      // With room for all, Debug still waits in "+".
      headerWidth = 1000;
      rendered = await renderComponent(view("fill-b"));
      await flush();
      expect(shown()).toEqual(["Changes", "Files", "Terminal", "Browser"]);
      expect(menuTabs()).toEqual(["debug"]);
      await rendered.unmount();
    } finally {
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});
