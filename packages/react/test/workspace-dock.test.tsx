import { describe, expect, test } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { WorkspaceDock } from "../src/components/workspace-dock";
import { registerDom, renderComponent } from "./render-hook";

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
      primary={<div>Chat pane</div>}
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
    const panel = rendered.container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);

    tabs[0]?.focus();
    await press(tabs[0] ?? null, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Files content");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[1]?.id);

    await press(tabs[1] ?? null, "End");
    expect(document.activeElement).toBe(tabs[2] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Terminal content");

    await press(tabs[2] ?? null, "ArrowRight");
    expect(document.activeElement).toBe(tabs[0] ?? null);
    expect(rendered.container.textContent ?? "").toContain("Changes content");

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

    expect(rendered.container.textContent ?? "").not.toContain("Run content");
    expect(rendered.container.querySelector('[title="Open workspace"]')).not.toBeNull();

    await click(rendered.container.querySelector('[title="Open workspace"]'));

    expect(rendered.container.textContent ?? "").toContain("Run content");

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
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent ?? "").toContain("Run content");
      expect(overlay?.querySelector('[aria-label="Open navigation"]')).not.toBeNull();

      // The overlay's own close control drives the same collapsed contract.
      await click(rendered.container.querySelector('[aria-label="Close workspace"]'));
      expect(changes.at(-1)).toBe(true);
      expect(
        rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]'),
      ).toBeNull();

      await rendered.unmount();
    });
  });
});
