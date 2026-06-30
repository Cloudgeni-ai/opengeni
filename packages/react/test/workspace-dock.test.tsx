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
});
