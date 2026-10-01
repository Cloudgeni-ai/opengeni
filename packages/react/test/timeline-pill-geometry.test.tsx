import { afterEach, expect, test } from "bun:test";
import { chooseQuestionPosition } from "../src/components/timeline-pill-geometry";
import { registerDom } from "./render-hook";

registerDom();
afterEach(() => document.body.replaceChildren());

function position(node: HTMLElement, x: number, y: number, width: number, height: number) {
  node.getBoundingClientRect = () => new DOMRect(x, y, width, height);
}

function fixture() {
  const scroller = document.createElement("div");
  const frame = document.createElement("div");
  frame.style.padding = "0 16px";
  const pill = document.createElement("button");
  frame.append(pill);
  document.body.append(scroller, frame);
  position(scroller, 0, 0, 390, 500);
  position(frame, 0, 44, 390, 30);
  position(pill, 204, 44, 170, 30);
  const addControl = (x: number, width: number) => {
    const control = document.createElement("button");
    position(control, x, 48, width, 32);
    scroller.append(control);
    return control;
  };
  return { scroller, frame, pill, addControl };
}

test("the full contextual pill moves below a toolbar only when every horizontal slot collides", () => {
  const { scroller, frame, pill, addControl } = fixture();
  const controls = [addControl(174, 58), addControl(294, 32), addControl(338, 32)];
  const preference = ["end", "center", "start"] as const;
  const shifted = chooseQuestionPosition(pill, frame, scroller, preference, {
    placement: "end",
    offsetY: 0,
  });
  expect(shifted).toEqual({ placement: "end", offsetY: 40 });
  position(frame, 0, 84, 390, 30);
  position(pill, 204, 84, 170, 30);
  expect(chooseQuestionPosition(pill, frame, scroller, preference, shifted)).toEqual(shifted);
  controls.forEach((control) => position(control, 174, -60, 58, 32));
  expect(chooseQuestionPosition(pill, frame, scroller, preference, shifted)).toEqual({
    placement: "end",
    offsetY: 0,
  });
});

test("even a thin control at the label edge prevents horizontal overlap", () => {
  const { scroller, frame, pill, addControl } = fixture();
  addControl(183, 2);
  position(pill, 16, 44, 170, 30);
  expect(
    chooseQuestionPosition(pill, frame, scroller, ["start", "center", "end"], {
      placement: "start",
      offsetY: 0,
    }),
  ).toEqual({ placement: "end", offsetY: 0 });
});

test("an unmeasured pill does not invent an offset", () => {
  const { scroller, frame, pill } = fixture();
  position(pill, 0, 0, 0, 0);
  expect(
    chooseQuestionPosition(pill, frame, scroller, ["end"], { placement: "end", offsetY: 0 }),
  ).toEqual({ placement: "end", offsetY: 0 });
});
