import { describe, expect, test } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { WorkspaceDock } from "../src/components/workspace-dock";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function press(element: Element | null, key: string): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function ControlledDock(props: {
  onCollapsedChange: (collapsed: boolean) => void;
  mobileLeadingControl?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <WorkspaceDock
      autoSaveId="og.test.workspace-dock"
      primary={
        <button type="button" aria-label="Host open workspace" onClick={() => setCollapsed(false)}>
          Chat pane
        </button>
      }
      tabs={[{ id: "run", label: "Run", content: <div>Run content</div> }]}
      collapsed={collapsed}
      onCollapsedChange={(next) => {
        props.onCollapsedChange(next);
        setCollapsed(next);
      }}
      mobileLeadingControl={props.mobileLeadingControl}
    />
  );
}

/** Force `useIsNarrow` to report a phone-width viewport for the callback's span. */
async function withNarrowViewport(run: () => Promise<void>): Promise<void> {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof window.matchMedia;
  try {
    await run();
  } finally {
    window.matchMedia = original;
  }
}

describe("WorkspaceDock", () => {
  test("tabs implement roving focus, arrow navigation, and a complete ARIA relationship", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-tabs"
        primary={<div>Chat pane</div>}
        tabs={[
          { id: "changes", label: "Changes", content: <div>Changes content</div> },
          { id: "files", label: "Files", content: <div>Files content</div> },
          { id: "terminal", label: "Terminal", content: <div>Terminal content</div> },
        ]}
      />,
    );

    const tabs = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panelFor = (tab: HTMLButtonElement | undefined) =>
      tab
        ? rendered.container.querySelector<HTMLElement>(
            `[id="${tab.getAttribute("aria-controls")}"]`,
          )
        : null;
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(new Set(tabs.map((tab) => tab.getAttribute("aria-controls"))).size).toBe(3);
    for (const tab of tabs) {
      expect(panelFor(tab)?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    expect(panelFor(tabs[0])?.hidden).toBe(false);

    tabs[0]?.focus();
    await press(tabs[0] ?? null, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Files content");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(panelFor(tabs[0])?.hidden).toBe(true);
    expect(panelFor(tabs[1])?.hidden).toBe(false);

    await press(tabs[1] ?? null, "End");
    expect(document.activeElement).toBe(tabs[2] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Terminal content");

    await press(tabs[2] ?? null, "ArrowRight");
    expect(document.activeElement).toBe(tabs[0] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Changes content");

    await rendered.unmount();
  });

  test("a visited tab stays mounted so file/editor/terminal state survives navigation", async () => {
    function StatefulFiles() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          File state {count}
        </button>
      );
    }
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-preserve-tabs"
        primary={<div>Chat pane</div>}
        tabs={[
          { id: "changes", label: "Changes", content: <div>Changes content</div> },
          { id: "files", label: "Files", content: <StatefulFiles /> },
        ]}
      />,
    );
    const findTab = (label: string) =>
      [...rendered.container.querySelectorAll('[role="tab"]')].find(
        (tab) => tab.textContent === label,
      ) ?? null;

    await click(findTab("Files"));
    await click(
      [...rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("File state"),
      ) ?? null,
    );
    expect(rendered.container.textContent ?? "").toContain("File state 1");
    await click(findTab("Changes"));
    await click(findTab("Files"));
    expect(rendered.container.textContent ?? "").toContain("File state 1");

    await click(rendered.container.querySelector('[title="Collapse"]'));
    await click(rendered.container.querySelector('[title="Open workspace"]'));
    expect(rendered.container.textContent ?? "").toContain("File state 1");

    await click(rendered.container.querySelector('[title="Maximize"]'));
    expect(rendered.container.querySelector('[title="Restore (Esc)"]')).not.toBeNull();
    await click(rendered.container.querySelector('[title="Restore (Esc)"]'));
    expect(rendered.container.textContent ?? "").toContain("File state 1");

    await rendered.unmount();
  });

  test("invalid and empty tab sets never produce substring matches or dangling ARIA", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        activeTab="file"
        autoSaveId="og.test.workspace-dock-invalid-tab"
        primary={<div>Chat pane</div>}
        tabs={[
          { id: "files", label: "Files", content: <div>Files content</div> },
          { id: "terminal", label: "Terminal", content: <div>Terminal content</div> },
        ]}
      />,
    );
    const first = rendered.container.querySelector<HTMLElement>('[role="tab"]');
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(rendered.container.textContent ?? "").toContain("Files content");

    await rendered.rerender(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-empty-tabs"
        primary={<div>Chat pane</div>}
        tabs={[]}
      />,
    );
    expect(rendered.container.querySelector('[role="tab"]')).toBeNull();
    const panel = rendered.container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBeNull();
    expect(panel?.getAttribute("aria-label")).toBe("Workspace");

    await rendered.unmount();
  });

  test("a host-controlled dock offers no built-in open/close controls", async () => {
    // The host's own toggle is the ONE open/close affordance: no chrome
    // Collapse button (it duplicated the host toggle) and no re-open rail.
    const rendered = await renderComponent(<ControlledDock onCollapsedChange={() => {}} />);

    expect(rendered.container.textContent ?? "").toContain("Run content");
    expect(rendered.container.querySelector('[title="Collapse"]')).toBeNull();
    expect(rendered.container.querySelector('[title="Open workspace"]')).toBeNull();
    // Maximize remains: a distinct mode, not an open/close duplicate.
    expect(rendered.container.querySelector('[title="Maximize"]')).not.toBeNull();

    await rendered.unmount();
  });

  test("an uncontrolled dock keeps its own collapse button and re-open rail", async () => {
    const rendered = await renderComponent(
      <WorkspaceDock
        autoSaveId="og.test.workspace-dock-uncontrolled"
        primary={<div>Chat pane</div>}
        tabs={[{ id: "run", label: "Run", content: <div>Run content</div> }]}
      />,
    );

    expect(rendered.container.textContent ?? "").toContain("Run content");

    await click(rendered.container.querySelector('[title="Collapse"]'));
    await flush(20);

    expect(
      rendered.container.querySelector("[data-workspace-surface]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(rendered.container.querySelector('[title="Open workspace"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("title")).toBe("Open workspace");

    await click(rendered.container.querySelector('[title="Open workspace"]'));

    expect(rendered.container.textContent ?? "").toContain("Run content");
    expect(
      rendered.container.querySelector("[data-workspace-surface]")?.getAttribute("aria-hidden"),
    ).toBeNull();

    await rendered.unmount();
  });

  test("below the breakpoint the dock is a full-screen overlay with no resize splitter", async () => {
    await withNarrowViewport(async () => {
      const changes: boolean[] = [];
      const rendered = await renderComponent(
        <ControlledDock
          onCollapsedChange={(collapsed) => changes.push(collapsed)}
          mobileLeadingControl={<button aria-label="Open navigation">Menu</button>}
        />,
      );

      // No drag splitter renders on a phone-width viewport.
      expect(rendered.container.querySelector("[data-separator-state]")).toBeNull();
      // The dock content is presented as a modal overlay, not a side column.
      const overlay = rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]');
      const primary = rendered.container.querySelector("[data-workspace-primary]");
      expect(overlay).not.toBeNull();
      expect(overlay?.hasAttribute("data-workspace-surface")).toBe(true);
      expect(overlay?.textContent ?? "").toContain("Run content");
      expect(overlay?.querySelector('[aria-label="Open navigation"]')).not.toBeNull();
      expect(primary?.getAttribute("inert")).not.toBeNull();
      expect(primary?.getAttribute("aria-hidden")).toBe("true");

      // The overlay's own close control drives the same collapsed contract.
      await click(rendered.container.querySelector('[aria-label="Close workspace"]'));
      expect(changes.at(-1)).toBe(true);
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]:not([hidden])'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"][hidden]'),
      ).not.toBeNull();
      expect(primary?.getAttribute("inert")).toBeNull();
      expect(primary?.getAttribute("aria-hidden")).toBeNull();

      const hostOpen = rendered.container.querySelector<HTMLElement>(
        '[aria-label="Host open workspace"]',
      );
      hostOpen?.focus();
      await click(hostOpen);
      await flush(20);
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]:not([hidden])'),
      ).not.toBeNull();
      expect(primary?.getAttribute("inert")).not.toBeNull();
      expect(primary?.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement?.getAttribute("role")).toBe("tab");

      await click(rendered.container.querySelector('[aria-label="Close workspace"]'));
      await flush(20);
      expect(document.activeElement).toBe(hostOpen ?? null);

      await rendered.unmount();
    });
  });

  test("an uncontrolled phone overlay always provides a focusable reopen affordance", async () => {
    await withNarrowViewport(async () => {
      const rendered = await renderComponent(
        <WorkspaceDock
          autoSaveId="og.test.workspace-dock-mobile-uncontrolled"
          primary={<div>Chat pane</div>}
          tabs={[{ id: "files", label: "Files", content: <div>Files content</div> }]}
        />,
      );
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]:not([hidden])'),
      ).not.toBeNull();

      await click(rendered.container.querySelector('[aria-label="Close workspace"]'));
      await flush(20);
      const reopen = rendered.container.querySelector<HTMLElement>('[title="Open workspace"]');
      expect(reopen).not.toBeNull();
      expect(document.activeElement).toBe(reopen ?? null);

      await click(reopen);
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]:not([hidden])'),
      ).not.toBeNull();
      await rendered.unmount();
    });
  });
});
