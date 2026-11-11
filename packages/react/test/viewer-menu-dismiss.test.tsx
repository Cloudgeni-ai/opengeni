import { expect, test } from "bun:test";
import { useViewerMenuDismiss } from "../src/components/use-viewer-menu-dismiss";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

function Menu() {
  const ref = useViewerMenuDismiss();
  return (
    <details ref={ref} open>
      <summary>Browser profile</summary>
      <button type="button">Inside menu</button>
    </details>
  );
}

test("Escape dismisses the menu before dock shortcuts and restores trigger focus", async () => {
  const rendered = await renderComponent(<Menu />);
  let dockEscapes = 0;
  const dock = () => {
    dockEscapes += 1;
  };
  document.addEventListener("keydown", dock);
  try {
    const input = rendered.container.querySelector("button")!;
    input.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    expect(rendered.container.querySelector("details")!.open).toBe(false);
    expect(document.activeElement).toBe(rendered.container.querySelector("summary"));
    expect(escape.defaultPrevented).toBe(true);
    expect(dockEscapes).toBe(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dockEscapes).toBe(1);
  } finally {
    document.removeEventListener("keydown", dock);
    await rendered.unmount();
  }
});

test("pointer input inside stays open; outside dismisses without swallowing input", async () => {
  const rendered = await renderComponent(<Menu />);
  const menu = rendered.container.querySelector("details")!;
  try {
    rendered.container
      .querySelector("button")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(menu.open).toBe(true);
    const outside = new Event("pointerdown", { bubbles: true, cancelable: true, composed: true });
    document.body.dispatchEvent(outside);
    expect(menu.open).toBe(false);
    expect(outside.defaultPrevented).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

function AdjacentMenus() {
  const first = useViewerMenuDismiss();
  const second = useViewerMenuDismiss();
  return (
    <>
      <details ref={first}>
        <summary>Browser sessions</summary>
        <button type="button">Choose session</button>
      </details>
      <details ref={second}>
        <summary>Browser profiles</summary>
        <button type="button">Choose profile</button>
      </details>
    </>
  );
}

test("keyboard focus leaving a menu closes it without stealing the next menu's focus", async () => {
  const rendered = await renderComponent(<AdjacentMenus />);
  let dockEscapes = 0;
  const dock = () => {
    dockEscapes += 1;
  };
  document.addEventListener("keydown", dock);
  try {
    const [first, second] = [...rendered.container.querySelectorAll<HTMLDetailsElement>("details")];
    first!.open = true;
    first!.querySelector("button")!.focus();
    const next = second!.querySelector("summary")!;
    next.focus();
    expect(first!.open).toBe(false);
    expect(document.activeElement === next).toBe(true);
    second!.open = true;
    second!.querySelector("button")!.focus();
    second!
      .querySelector("button")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    expect(second!.open).toBe(false);
    expect(document.activeElement === next).toBe(true);
    expect(dockEscapes).toBe(0);
    first!.open = true;
    next.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(first!.open).toBe(true);
    expect(document.activeElement === next).toBe(true);
    expect(dockEscapes).toBe(1);
  } finally {
    document.removeEventListener("keydown", dock);
    await rendered.unmount();
  }
});
