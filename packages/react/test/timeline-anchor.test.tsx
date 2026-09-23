import { expect, test } from "bun:test";
import {
  TimelineBeforeLayout,
  captureTimelineAnchor,
  timelineAnchorCorrection,
} from "../src/components/timeline-anchor";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

function position(element: HTMLElement, top: number, height = 40) {
  element.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 600,
    width: 600,
    x: 0,
    y: top,
    toJSON() {},
  });
}

test("capture runs against the old DOM immediately before the replacement commit", async () => {
  const seen: string[] = [];
  let text: HTMLElement | null = null;
  const render = (value: string) => (
    <TimelineBeforeLayout capture={() => seen.push(text?.textContent ?? "missing")}>
      <p
        ref={(node) => {
          text = node;
        }}
      >
        {value}
      </p>
    </TimelineBeforeLayout>
  );
  const view = await renderComponent(render("old content"));
  await view.rerender(render("new content"));
  expect(seen).toEqual(["old content"]);
  await view.unmount();
});

test("retained paragraph anchors reconstructed rows and subtracts native anchoring", () => {
  const scroller = document.createElement("div");
  scroller.innerHTML = '<div data-og-group-key="old"><p>Retained paragraph being read.</p></div>';
  const group = scroller.firstElementChild as HTMLElement;
  const paragraph = group.firstElementChild as HTMLElement;
  position(scroller, 50, 400);
  position(group, 80, 200);
  position(paragraph, 100);
  const anchors = captureTimelineAnchor(scroller)!;
  group.remove();
  scroller.innerHTML =
    '<div data-og-group-key="new"><p>Earlier text newly loaded.</p><p>Retained paragraph being read.</p></div>';
  const replacement = scroller.querySelectorAll("p")[1]!;
  position(replacement, 180);
  expect(timelineAnchorCorrection(scroller, anchors)).toBe(80);
  position(replacement, 100);
  expect(timelineAnchorCorrection(scroller, anchors)).toBe(0);
});

test("focused disclosure takes priority over the paragraph moving below it", () => {
  const scroller = document.createElement("div");
  scroller.innerHTML =
    '<div data-og-group-key="turn"><button aria-expanded="false">4 steps</button><p>Paragraph below expanded activity.</p></div>';
  document.body.append(scroller);
  const button = scroller.querySelector("button")!;
  const paragraph = scroller.querySelector("p")!;
  position(scroller, 50, 400);
  position(scroller.firstElementChild as HTMLElement, 80, 250);
  position(button, 100);
  position(paragraph, 150);
  button.focus();
  const anchors = captureTimelineAnchor(scroller)!;
  position(button, 160);
  position(paragraph, 400);
  expect(timelineAnchorCorrection(scroller, anchors)).toBe(60);
  scroller.remove();
});

test("capture measures each group once and retained anchors avoid a group lookup", () => {
  const scroller = document.createElement("div");
  scroller.innerHTML = '<div data-og-group-key="row">Short row</div>';
  const group = scroller.firstElementChild as HTMLElement;
  position(scroller, 0, 400);
  position(group, 20);
  const measure = group.getBoundingClientRect;
  let reads = 0;
  group.getBoundingClientRect = () => {
    reads += 1;
    return measure();
  };
  const anchors = captureTimelineAnchor(scroller)!;
  expect(reads).toBe(1);
  scroller.querySelectorAll = () => {
    throw new Error("Retained anchor must not enumerate the replacement DOM");
  };
  expect(timelineAnchorCorrection(scroller, anchors)).toBe(0);
  expect(reads).toBe(2);
});
