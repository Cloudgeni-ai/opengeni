import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ResizeHandle, type ResizeHandleProps } from "./resize-handle";

describe("ResizeHandle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let ownsDom = false;
  beforeAll(() => {
    ownsDom = !GlobalRegistrator.isRegistered;
    if (ownsDom) GlobalRegistrator.register();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
  afterAll(async () => {
    if (ownsDom) await GlobalRegistrator.unregister();
  });

  type Calls = { resize: number[]; end: number[]; reset: number; collapse: number };
  async function draw(props: Partial<ResizeHandleProps> = {}) {
    const calls: Calls = { resize: [], end: [], reset: 0, collapse: 0 };
    await act(async () =>
      root.render(
        <ResizeHandle
          label="Resize chat"
          controls="panel"
          value={400}
          min={320}
          max={720}
          edge="start"
          onResize={(width) => calls.resize.push(width)}
          onResizeEnd={(width) => calls.end.push(width)}
          onReset={() => (calls.reset += 1)}
          onCollapse={() => (calls.collapse += 1)}
          {...props}
        />,
      ),
    );
    const handle = container.querySelector<HTMLElement>("[role='separator']")!;
    return { calls, handle };
  }
  const key = (element: HTMLElement, name: string, shiftKey = false) =>
    act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
    });
  // A move carries the pressed button unless told otherwise.
  const pointer = (target: EventTarget, type: string, clientX: number, buttons?: number) =>
    act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          button: 0,
          buttons: buttons ?? (type === "pointermove" ? 1 : 0),
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  const cover = () => document.body.querySelector("[data-resize-cover]");

  test("is a focusable vertical separator whose value is the panel width", async () => {
    const { handle } = await draw({ max: 280 });
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize chat");
    expect(handle.getAttribute("aria-controls")).toBe("panel");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    expect(handle.getAttribute("aria-valuetext")).toBe("400 pixels");
    expect(handle.getAttribute("aria-valuemin")).toBe("320");
    // A window too narrow for the panel's own limit never reports max < min.
    expect(handle.getAttribute("aria-valuemax")).toBe("320");
  });

  test("arrow keys step the width, Shift steps further, Home and End go to the limits", async () => {
    const { calls, handle } = await draw();
    // On a panel's left edge, Left widens it.
    await key(handle, "ArrowLeft");
    await key(handle, "ArrowRight");
    await key(handle, "ArrowLeft", true);
    await key(handle, "Home");
    await key(handle, "End");
    expect(calls.end).toEqual([416, 384, 464, 320, 720]);
  });

  test("on a panel's right edge, Right widens it", async () => {
    const { calls, handle } = await draw({ edge: "end" });
    await key(handle, "ArrowRight");
    expect(calls.end).toEqual([416]);
  });

  test("keys stop at the limits and report nothing when the width can't change", async () => {
    const { calls, handle } = await draw({ value: 712 });
    await key(handle, "ArrowLeft", true);
    expect(calls.end).toEqual([720]);
    const atMin = await draw({ value: 320 });
    await key(atMin.handle, "ArrowRight");
    await key(atMin.handle, "Home");
    expect(atMin.calls.end).toEqual([]);
    // Other keys are left alone.
    await key(atMin.handle, "a");
    expect(atMin.calls.end).toEqual([]);
  });

  test("Enter hides the panel when it can be hidden", async () => {
    const { calls, handle } = await draw();
    await key(handle, "Enter");
    expect(calls.collapse).toBe(1);
    const fixed = await draw({ onCollapse: undefined });
    await key(fixed.handle, "Enter");
    expect(fixed.calls.collapse).toBe(0);
  });

  test("dragging reports each width live and the chosen one once, within the limits", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    // A cover over the whole page keeps an iframe under the pointer from
    // swallowing the drag, outside any ancestor that could contain it.
    expect(cover()?.parentElement).toBe(document.body);
    expect(container.contains(cover())).toBe(false);
    expect(handle.getAttribute("data-dragging")).toBe("true");
    expect(document.body.style.cursor).toBe("col-resize");
    await pointer(window, "pointermove", 900);
    await pointer(window, "pointermove", 900);
    expect(handle.getAttribute("aria-valuenow")).toBe("500");
    await pointer(window, "pointermove", 0);
    await pointer(window, "pointerup", 0);
    expect(calls.resize).toEqual([500, 720]);
    expect(calls.end).toEqual([720]);
    expect(cover()).toBeNull();
    expect(handle.hasAttribute("data-dragging")).toBe(false);
    expect(document.body.style.cursor).toBe("");
    // Released listeners: later movement changes nothing.
    await pointer(window, "pointermove", 800);
    expect(calls.resize).toEqual([500, 720]);
  });

  test("a double-click resets the width; a single click or a drag does not", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointerup", 1000);
    expect(calls.reset).toBe(0);
    await pointer(handle, "pointerdown", 1001);
    await pointer(window, "pointerup", 1001);
    expect(calls.reset).toBe(1);
    expect(calls.end).toEqual([]);
    // A drag between the presses is not a double-click.
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointerup", 1000);
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointerup", 960);
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointerup", 1000);
    expect(calls.reset).toBe(1);
    expect(calls.end).toEqual([440]);
  });

  test("a drag that ends where it started puts the width back and isn't a click", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointermove", 900);
    await pointer(window, "pointerup", 1000);
    expect(calls.resize.at(-1)).toBe(400);
    expect(calls.end).toEqual([]);
    // At a limit the width can't change, but the pointer moved: not a click.
    const atMax = await draw({ value: 720 });
    await pointer(atMax.handle, "pointerdown", 1000);
    await pointer(window, "pointermove", 900);
    await pointer(window, "pointerup", 900);
    await pointer(atMax.handle, "pointerdown", 1000);
    await pointer(window, "pointerup", 1000);
    expect(atMax.calls.reset).toBe(0);
    expect(atMax.calls.end).toEqual([]);
  });

  test("a release the page missed ends the drag at the next move", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointermove", 900);
    // No button held any more: the release happened outside the window.
    await pointer(window, "pointermove", 880, 0);
    expect(calls.end).toEqual([520]);
    expect(cover()).toBeNull();
    await pointer(window, "pointermove", 700);
    expect(calls.end).toEqual([520]);
  });

  test("a cancelled pointer or the window losing focus keeps where the drag got to", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointermove", 900);
    await pointer(window, "pointercancel", 900);
    expect(calls.end).toEqual([500]);
    expect(cover()).toBeNull();
    await pointer(handle, "pointerdown", 1000);
    await pointer(window, "pointermove", 950);
    await act(async () => void window.dispatchEvent(new Event("blur")));
    expect(calls.end).toEqual([500, 450]);
    expect(cover()).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  test("unmounting mid-drag leaves no listeners or page styles behind", async () => {
    const { calls, handle } = await draw();
    await pointer(handle, "pointerdown", 1000);
    await act(async () => root.render(<div />));
    expect(cover()).toBeNull();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    await pointer(window, "pointermove", 900);
    await pointer(window, "pointerup", 900);
    expect(calls.resize).toEqual([]);
    expect(calls.end).toEqual([]);
  });
});
