import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { WorkspaceDock } from "../src/components/workspace-dock";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function ControlledDock(props: { onCollapsedChange: (collapsed: boolean) => void }) {
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
  test("dock collapse controls can be owned by the host", async () => {
    const changes: boolean[] = [];
    const rendered = await renderComponent(
      <ControlledDock onCollapsedChange={(collapsed) => changes.push(collapsed)} />,
    );

    expect(rendered.container.textContent ?? "").toContain("Run content");
    expect(rendered.container.querySelector('[title="Open workspace"]')).toBeNull();

    await click(rendered.container.querySelector('[title="Collapse"]'));

    expect(changes.at(-1)).toBe(true);
    expect(rendered.container.textContent ?? "").not.toContain("Run content");
    expect(rendered.container.querySelector('[title="Open workspace"]')).not.toBeNull();

    await click(rendered.container.querySelector('[title="Open workspace"]'));

    expect(changes.at(-1)).toBe(false);
    expect(rendered.container.textContent ?? "").toContain("Run content");

    await rendered.unmount();
  });

  test("below the breakpoint the dock is a full-screen overlay with no resize splitter", async () => {
    await withNarrowViewport(async () => {
      const changes: boolean[] = [];
      const rendered = await renderComponent(
        <ControlledDock onCollapsedChange={(collapsed) => changes.push(collapsed)} />,
      );

      // No drag splitter renders on a phone-width viewport.
      expect(rendered.container.querySelector("[data-separator-state]")).toBeNull();
      // The dock content is presented as a modal overlay, not a side column.
      const overlay = rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]');
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent ?? "").toContain("Run content");

      // The overlay's own close control drives the same collapsed contract.
      await click(rendered.container.querySelector('[aria-label="Close workspace"]'));
      expect(changes.at(-1)).toBe(true);
      expect(rendered.container.querySelector('[role="dialog"][aria-label="Workspace"]')).toBeNull();

      await rendered.unmount();
    });
  });
});
