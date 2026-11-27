import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

registerDom();

type Finish = (result: { finished: boolean }) => void;
const platform = { OS: "ios" };
const animations: { toValue: number; finish: Finish | null; stopped: boolean }[] = [];
const modals: { visible: boolean; onRequestClose(): void }[] = [];
let keyboardDismissals = 0;

mock.module("react-native", () => {
  class Value {
    interpolate() {
      return this;
    }
  }
  return {
    Platform: platform,
    StyleSheet: { absoluteFill: {} },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Keyboard: {
      dismiss() {
        keyboardDismissals++;
      },
    },
    Modal: (props: { visible: boolean; onRequestClose(): void; children?: ReactNode }) => {
      modals.push(props);
      return props.visible ? createElement("dialog", null, props.children) : null;
    },
    Animated: {
      Value,
      View: (props: { pointerEvents?: string; children?: ReactNode }) =>
        createElement("div", { "data-layer": props.pointerEvents }, props.children),
      timing: (_value: unknown, config: { toValue: number }) => {
        const animation = {
          toValue: config.toValue,
          finish: null as Finish | null,
          stopped: false,
        };
        animations.push(animation);
        return {
          start(finish: Finish) {
            animation.finish = finish;
          },
          stop() {
            animation.stopped = true;
          },
        };
      },
    },
  };
});
mock.module("react-native-screens", () => ({
  FullWindowOverlay: (props: { children?: ReactNode }) =>
    createElement("section", { "data-window-overlay": "" }, props.children),
}));

const { CallSurfaceLayer } = await import("../src/realtime/call-surface-layer");

function app(visible: boolean, onRequestClose = () => {}) {
  return (
    <main>
      <p id="underneath">Screen underneath</p>
      <CallSurfaceLayer visible={visible} onRequestClose={onRequestClose}>
        <p>Call screen</p>
      </CallSurfaceLayer>
    </main>
  );
}

/** Completes the latest slide, as the native driver reports it. */
async function finishLatest(finished = true) {
  const latest = animations.at(-1)!;
  await act(async () => latest.finish?.({ finished }));
}

describe("call surface layer", () => {
  beforeEach(() => {
    platform.OS = "ios";
    animations.length = 0;
    modals.length = 0;
    keyboardDismissals = 0;
  });

  test("minimizing removes the whole surface and keeps the screen underneath", async () => {
    const rendered = await renderComponent(app(true));
    const underneath = rendered.container.querySelector("#underneath");
    expect(rendered.container.querySelector("[data-window-overlay]")?.textContent).toBe(
      "Call screen",
    );
    expect(rendered.container.querySelector("[data-layer]")?.getAttribute("data-layer")).toBe(
      "auto",
    );
    expect(keyboardDismissals).toBe(1);

    await rendered.rerender(app(false));
    // While it slides away it no longer takes touches.
    expect(rendered.container.querySelector("[data-layer]")?.getAttribute("data-layer")).toBe(
      "none",
    );
    expect(animations.at(-1)?.toValue).toBe(0);
    await finishLatest();
    // Nothing of the surface is left over the app: no layer, no window overlay.
    expect(rendered.container.querySelector("[data-window-overlay]")).toBeNull();
    expect(rendered.container.querySelector("[data-layer]")).toBeNull();
    expect(rendered.container.textContent).toBe("Screen underneath");
    expect(rendered.container.querySelector("#underneath")).toBe(underneath);
    await rendered.unmount();
  });

  test("opening again during the slide away keeps the surface up", async () => {
    const rendered = await renderComponent(app(true));
    await finishLatest();
    await rendered.rerender(app(false));
    const leaving = animations.at(-1)!;
    await rendered.rerender(app(true));
    expect(leaving.stopped).toBe(true);
    // The interrupted slide reports unfinished and must not unmount the reopened surface.
    await act(async () => leaving.finish?.({ finished: false }));
    expect(rendered.container.querySelector("[data-window-overlay]")?.textContent).toBe(
      "Call screen",
    );
    expect(animations.at(-1)?.toValue).toBe(1);
    await rendered.unmount();
  });

  test("starts hidden without mounting anything over the app", async () => {
    const rendered = await renderComponent(app(false));
    expect(rendered.container.querySelector("[data-window-overlay]")).toBeNull();
    expect(rendered.container.querySelector("[data-layer]")).toBeNull();
    expect(animations).toEqual([]);
    await rendered.unmount();
  });

  test("on Android it is the dialog window Modal, and Back minimizes", async () => {
    platform.OS = "android";
    let closes = 0;
    const close = () => closes++;
    const rendered = await renderComponent(app(true, close));
    expect(rendered.container.querySelector("[data-window-overlay]")).toBeNull();
    expect(rendered.container.querySelector("dialog")?.textContent).toBe("Call screen");
    modals.at(-1)!.onRequestClose();
    expect(closes).toBe(1);

    await rendered.rerender(app(false, close));
    expect(modals.at(-1)!.visible).toBe(false);
    expect(rendered.container.querySelector("dialog")).toBeNull();
    expect(rendered.container.textContent).toBe("Screen underneath");
    await rendered.unmount();
  });
});
