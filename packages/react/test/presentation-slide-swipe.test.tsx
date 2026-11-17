import { describe, expect, test } from "bun:test";
import { Presentation } from "@opengeni/artifact-tool/reference";

import type { PresentationCommit } from "../src/artifacts-presentation";
import { slideSwipeStep } from "../src/components/artifacts/presentation-editor";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { PresentationEditor } = await import("../src/artifacts-presentation");

function deck(slides: number) {
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  for (let index = 0; index < slides; index += 1) {
    const slide = presentation.slides.add();
    slide.title = `Slide ${index + 1}`;
    slide.shapes.add({
      geometry: "textbox",
      name: `title-${index}`,
      text: `Title ${index + 1}`,
      position: { left: 0, top: 0, width: 1280, height: 720 },
    });
  }
  return presentation;
}

function touch(target: Element, type: string, x: number, y = 100) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("slideSwipeStep", () => {
  test("left goes forward, right goes back", () => {
    expect(slideSwipeStep({ dx: -80, dy: 6, canScrollX: false })).toBe(1);
    expect(slideSwipeStep({ dx: 80, dy: -6, canScrollX: false })).toBe(-1);
  });

  test("short, vertical and zoomed gestures do nothing", () => {
    expect(slideSwipeStep({ dx: -20, dy: 0, canScrollX: false })).toBeNull();
    expect(slideSwipeStep({ dx: -80, dy: 70, canScrollX: false })).toBeNull();
    expect(slideSwipeStep({ dx: -200, dy: 0, canScrollX: true })).toBeNull();
  });
});

describe("presentation touch swipe", () => {
  test("a swipe across an object turns the slide without moving the object", async () => {
    const presentation = deck(3);
    const shape = presentation.slides.items[0]!.shapes.items[0]!;
    const before = { ...shape.position };
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    try {
      await flush();
      const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
      const counter = () =>
        rendered.container.querySelector("[data-og-mobile-slide-selector]")!.textContent;
      expect(counter()).toBe("1 / 3");
      await actRun(() => {
        touch(editor, "pointerdown", 300);
        touch(editor, "pointermove", 200);
        touch(editor, "pointerup", 150);
      });
      expect(counter()).toBe("2 / 3");
      await actRun(() => {
        touch(editor, "pointerdown", 100);
        touch(editor, "pointerup", 260);
      });
      expect(counter()).toBe("1 / 3");
      expect(shape.position).toEqual(before);
      expect(commits).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a tap still selects the object under the finger", async () => {
    const presentation = deck(2);
    const rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
    try {
      await flush();
      const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
      expect(rendered.container.querySelector("[data-og-presentation-object]")).toBeNull();
      await actRun(() => {
        touch(editor, "pointerdown", 100);
        touch(editor, "pointerup", 102);
      });
      expect(rendered.container.querySelector("[data-og-presentation-object]")).not.toBeNull();
      expect(rendered.container.querySelector("[data-og-mobile-slide-selector]")!.textContent).toBe(
        "1 / 2",
      );
    } finally {
      await rendered.unmount();
    }
  });
});
