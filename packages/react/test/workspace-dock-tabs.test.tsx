import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

// A semantic stand-in for the Radix menu: the same trigger and items, rendered
// in place, so the "+" choices can be read and clicked in happy-dom.
mock.module("../src/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: ReactNode;
      onSelect?: () => void;
      [key: string]: unknown;
    }) => (
      <button
        type="button"
        role="menuitem"
        data-dock-menu-tab={rest["data-dock-menu-tab"] as string | undefined}
        onClick={() => onSelect?.()}
      >
        {children}
      </button>
    ),
  };
});

const { act } = await import("react");
const { WorkspaceDock } = await import("../src/components/workspace-dock");

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("WorkspaceDock tab strip", () => {
  test("optional tabs wait under + until opened, and close back into it", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-optional"
        tabScope="chat-1"
        primary={<div>Chat pane</div>}
        tabs={[
          { id: "changes", label: "Changes", content: <div>Changes content</div> },
          { id: "files", label: "Files", optional: true, content: <div>Files content</div> },
          {
            id: "terminal",
            label: "Terminal",
            optional: true,
            content: <div>Terminal content</div>,
          },
        ]}
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
    const add = rendered.container.querySelector<HTMLButtonElement>("[data-dock-add-tab]");
    expect(add?.getAttribute("aria-label")).toBe("Open panel");
    const menuTabs = () =>
      [...rendered.container.querySelectorAll<HTMLElement>("[data-dock-menu-tab]")].map((item) =>
        item.getAttribute("data-dock-menu-tab"),
      );
    expect(menuTabs()).toEqual(["files", "terminal"]);
    await click(rendered.container.querySelector('[data-dock-menu-tab="files"]'));
    await flush();
    expect(shown()).toEqual(["Changes", "Files"]);
    expect(menuTabs()).toEqual(["terminal"]);
    expect(rendered.container.textContent ?? "").toContain("Files content");

    // Close Files: it returns to "+" and the neighbouring tab takes over.
    await click(rendered.container.querySelector('[data-dock-tab-close="files"]'));
    await flush();
    expect(shown()).toEqual(["Changes"]);
    expect(
      rendered.container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Changes");
    await rendered.unmount();
  });
});
