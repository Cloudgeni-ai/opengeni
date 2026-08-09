import { describe, expect, test } from "bun:test";
import { Presentation } from "@opengeni/artifact-tool/reference";

import {
  PresentationArtifactSurface,
  PresentationEditor,
  PresentationProjectionEditor,
  type PresentationCommit,
  type PresentationEditorProjection,
} from "../src/artifacts-presentation";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function makePresentation(slides = 1, objectsPerSlide = 1) {
  const presentation = Presentation.create({
    slideSize: { width: 1280, height: 720 },
  });
  for (let slideIndex = 0; slideIndex < slides; slideIndex += 1) {
    const slide = presentation.slides.add();
    slide.title = `Slide ${slideIndex + 1}`;
    for (let objectIndex = 0; objectIndex < objectsPerSlide; objectIndex += 1) {
      slide.shapes.add({
        geometry: "textbox",
        name: `object-${slideIndex}-${objectIndex}`,
        text: `Object ${slideIndex}-${objectIndex}`,
        position: {
          left: (objectIndex % 20) * 62,
          top: Math.floor(objectIndex / 20) * 34,
          width: 56,
          height: 28,
        },
        fill: objectIndex % 2 === 0 ? "slate-100" : "white",
        line: { fill: "slate-300", width: 1 },
      });
    }
  }
  return presentation;
}

function replaceTextAreaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function installRecordingCanvas(calls: string[]): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement) {
      return new Proxy(
        {
          canvas: this,
          measureText: (text: string) => ({ width: text.length * 8 }),
        } as unknown as CanvasRenderingContext2D,
        {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (value !== undefined) return value;
            return () => calls.push(String(property));
          },
        },
      );
    },
  });
  return () => {
    if (original) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  };
}

describe("presentation artifact surface", () => {
  test("hundreds of slides and objects keep a bounded DOM", async () => {
    const presentation = makePresentation(500, 500);
    const rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
    await flush();

    const rail = rendered.container.querySelector("[data-og-slide-rail]") as HTMLDivElement;
    const options = rendered.container.querySelectorAll('[role="option"][data-og-slide-index]');
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThan(20);
    expect(rendered.container.querySelectorAll("canvas").length).toBeLessThan(20);
    expect(rendered.container.querySelectorAll("[data-og-presentation-object]").length).toBe(0);

    rail.scrollTop = 40_000;
    await actRun(() => rail.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    const indexes = [
      ...rendered.container.querySelectorAll<HTMLElement>("[data-og-slide-index]"),
    ].map((element) => Number(element.dataset.ogSlideIndex));
    expect(Math.min(...indexes)).toBeGreaterThan(300);
    expect(indexes.length).toBeLessThan(20);

    await rendered.unmount();
  });

  test("keyboard selection, movement, resize, and text edits commit to the public model", async () => {
    const presentation = makePresentation();
    const shape = presentation.slides.items[0]!.shapes.items[0]!;
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    await actRun(() => editor.focus());
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    await flush();

    expect(shape.position.left).toBe(1);
    expect(shape.position.height).toBe(29);
    expect(commits.map((commit) => commit.kind)).toEqual(["move", "resize"]);
    expect(rendered.container.querySelector("[data-og-presentation-object]")).toBeTruthy();

    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();
    const textEditor = rendered.container.querySelector(
      '[aria-label="Edit object-0-0"]',
    ) as HTMLTextAreaElement;
    expect(textEditor).toBeTruthy();
    await actRun(() => replaceTextAreaValue(textEditor, "Edited on canvas"));
    await actRun(() =>
      textEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    );
    await flush();

    expect(shape.text.toString()).toBe("Edited on canvas");
    expect(commits.at(-1)).toMatchObject({
      kind: "text",
      objectId: shape.id,
      before: "Object 0-0",
      after: "Edited on canvas",
    });

    await rendered.unmount();
  });

  test("pointer release commits its exact final coordinate, independent of render timing", async () => {
    const presentation = makePresentation();
    const shape = presentation.slides.items[0]!.shapes.items[0]!;
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    editor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 }) as DOMRect;
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 7,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 7,
          clientX: 20,
          clientY: 15,
        }),
      ),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 7,
          clientX: 25,
          clientY: 20,
        }),
      ),
    );
    await flush();

    expect(shape.position).toMatchObject({ left: 15, top: 10 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      kind: "move",
      after: { left: 15, top: 10 },
    });

    await rendered.unmount();
  });

  test("viewport culling accounts for the padded stage origin and rotated bounds", async () => {
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slide = presentation.slides.add();
    slide.shapes.add({
      geometry: "rect",
      name: "near-overscan-edge",
      position: { left: 85, top: 20, width: 10, height: 10 },
    });
    slide.shapes.add({
      geometry: "rect",
      name: "rotated-edge",
      rotation: 45,
      position: { left: 250, top: 20, width: 100, height: 100 },
    });
    const rendered = await renderComponent(
      <PresentationEditor presentation={presentation} zoom={1} />,
    );
    await flush();

    const viewport = rendered.container.querySelector(
      "[data-og-presentation-viewport]",
    ) as HTMLDivElement;
    const stage = rendered.container.querySelector(
      "[data-og-presentation-stage]",
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 160 },
    });
    Object.defineProperties(stage, {
      offsetLeft: { configurable: true, value: 24 },
      offsetTop: { configurable: true, value: 24 },
    });
    viewport.scrollLeft = 200;
    viewport.scrollTop = 24;
    await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();

    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-painted-object-count"),
    ).toBe("2");

    await rendered.unmount();
  });

  test("fits an uncontrolled slide after the real host viewport becomes narrower", async () => {
    const presentation = makePresentation();
    const zoomChanges: number[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        onZoomChange={(zoom) => zoomChanges.push(zoom)}
      />,
    );
    await flush();
    const viewport = rendered.container.querySelector(
      "[data-og-presentation-viewport]",
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 600 },
    });
    await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();

    const stage = rendered.container.querySelector(
      "[data-og-presentation-stage]",
    ) as HTMLDivElement;
    expect(Number.parseFloat(stage.style.width)).toBeLessThanOrEqual(312);
    expect(zoomChanges.at(-1)).toBeCloseTo(312 / 1280, 5);
    await rendered.unmount();
  });

  test("places a new text box in the first clear composition slot", async () => {
    const presentation = makePresentation();
    const existing = presentation.slides.items[0]!.shapes.items[0]!;
    existing.position = { left: 256, top: 144, width: 768, height: 115.2 };
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();
    await actRun(() =>
      rendered.container
        .querySelector<HTMLButtonElement>('button[aria-label="Add text box"]')!
        .click(),
    );
    await flush();
    const inserted = commits.at(-1);
    expect(inserted?.kind).toBe("object-insert");
    if (inserted?.kind !== "object-insert") throw new Error("Expected text-box insertion");
    expect(inserted.position.left).toBe(256);
    expect(inserted.position.top).toBe(302.4);
    await rendered.unmount();
  });

  test("resize drags capture and release on the stable canvas overlay", async () => {
    const presentation = makePresentation();
    const rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
    await flush();
    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    editor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 }) as DOMRect;
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await flush();
    const handle = rendered.container.querySelector(
      "[data-og-presentation-object] circle",
    ) as SVGCircleElement;
    const captured: number[] = [];
    const released: number[] = [];
    let activePointer: number | null = null;
    editor.setPointerCapture = (pointerId) => {
      activePointer = pointerId;
      captured.push(pointerId);
    };
    editor.hasPointerCapture = (pointerId) => activePointer === pointerId;
    editor.releasePointerCapture = (pointerId) => {
      activePointer = null;
      released.push(pointerId);
    };

    await actRun(() =>
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 19,
          clientX: 56,
          clientY: 28,
        }),
      ),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 19,
          clientX: 66,
          clientY: 38,
        }),
      ),
    );

    expect(captured).toEqual([19]);
    expect(released).toEqual([19]);
    await rendered.unmount();
  });

  test("resize deltas follow a rotated object's local axes", async () => {
    const presentation = makePresentation();
    const shape = presentation.slides.items[0]!.shapes.items[0]!;
    shape.rotation = 90;
    const rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
    await flush();
    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    editor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 }) as DOMRect;
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await flush();
    const selection = rendered.container.querySelector(
      "[data-og-presentation-object]",
    ) as SVGGElement;
    expect(selection.getAttribute("transform")).toContain("rotate(90");
    const handle = selection.querySelector("circle") as SVGCircleElement;

    await actRun(() =>
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 23,
          clientX: 56,
          clientY: 28,
        }),
      ),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 23,
          clientX: 56,
          clientY: 38,
        }),
      ),
    );
    await flush();

    expect(shape.position.width).toBeCloseTo(66);
    expect(shape.position.height).toBeCloseTo(28);
    await rendered.unmount();
  });

  test("controlled slide changes discard stale text-edit state", async () => {
    const presentation = makePresentation(2, 1);
    const first = presentation.slides.items[0]!;
    const second = presentation.slides.items[1]!;
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        activeSlideId={first.id}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();
    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();
    expect(rendered.container.querySelector("textarea")).toBeTruthy();

    await rendered.rerender(
      <PresentationEditor
        presentation={presentation}
        activeSlideId={second.id}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await rendered.rerender(
      <PresentationEditor
        presentation={presentation}
        activeSlideId={first.id}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    expect(rendered.container.querySelector("textarea")).toBeNull();
    expect(commits).toEqual([]);
    await rendered.unmount();
  });

  test("multiple editors expose unique slide IDs and keyboard-operable slide rails", async () => {
    const first = makePresentation(3, 1);
    const second = makePresentation(3, 1);
    const rendered = await renderComponent(
      <>
        <PresentationEditor presentation={first} />
        <PresentationEditor presentation={second} />
      </>,
    );
    await flush();
    const rails = rendered.container.querySelectorAll<HTMLDivElement>('[role="listbox"]');
    const firstActiveId = rails[0]?.getAttribute("aria-activedescendant");
    const secondActiveId = rails[1]?.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();
    expect(secondActiveId).toBeTruthy();
    expect(firstActiveId).not.toBe(secondActiveId);
    expect(rendered.container.querySelector(`#${firstActiveId}`)).toBeTruthy();
    expect(rendered.container.querySelector(`#${secondActiveId}`)).toBeTruthy();

    await actRun(() =>
      rails[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await flush();
    expect(rendered.container.textContent).toContain("3 / 3");

    await rendered.unmount();
  });

  test("canonical element order includes tables and groups in selection and hit testing", async () => {
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slide = presentation.slides.add();
    const shape = slide.shapes.add({
      geometry: "rect",
      name: "underlay",
      position: { left: 0, top: 0, width: 120, height: 80 },
    });
    const table = slide.tables.add({
      name: "data-table",
      position: { left: 0, top: 0, width: 120, height: 80 },
      rows: [["A", "B"]],
    });
    const group = slide.groups.add({
      name: "feature-group",
      position: { left: 180, top: 0, width: 120, height: 80 },
      children: [
        {
          kind: "shape",
          config: {
            geometry: "ellipse",
            position: { left: 0, top: 0, width: 120, height: 80 },
          },
        },
      ],
    });
    expect(slide.elements.map((element) => element.id)).toEqual([shape.id, table.id, group.id]);
    const selected: string[] = [];
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        zoom={1}
        onSelectionChange={(object) => {
          if (object) selected.push(object.id);
        }}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();
    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    editor.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 }) as DOMRect;

    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 31,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
    await actRun(() =>
      editor.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 31,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
    expect(selected.at(-1)).toBe(table.id);

    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();
    expect(selected.at(-1)).toBe(group.id);
    expect(group.position.left).toBe(181);
    expect(commits.at(-1)).toMatchObject({ kind: "move", objectId: group.id });
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-painted-object-count"),
    ).toBe("3");

    await rendered.unmount();
  });

  test("canvas projection executes table and nested group scene operations", async () => {
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slide = presentation.slides.add();
    slide.tables.add({
      name: "merged-table",
      position: { left: 40, top: 40, width: 320, height: 120 },
      rows: [
        [{ text: "Merged", colSpan: 2 }, null],
        ["Left", "Right"],
      ],
    });
    slide.groups.add({
      name: "nested",
      position: { left: 420, top: 80, width: 240, height: 160 },
      rotation: 12,
      flipHorizontal: true,
      children: [
        {
          kind: "group",
          config: {
            position: { left: 0, top: 0, width: 240, height: 160 },
            children: [
              {
                kind: "shape",
                config: {
                  geometry: "roundRect",
                  text: "Nested",
                  position: { left: 20, top: 20, width: 120, height: 60 },
                },
              },
            ],
          },
        },
      ],
    });
    const calls: string[] = [];
    const restoreCanvas = installRecordingCanvas(calls);
    try {
      const rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
      await flush();
      expect(calls).toContain("rect");
      expect(calls).toContain("translate");
      expect(calls).toContain("rotate");
      expect(calls).toContain("scale");
      await rendered.unmount();
    } finally {
      restoreCanvas();
    }
  });

  test("canvas projection covers every chart family and mixed-sign domains", async () => {
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slide = presentation.slides.add();
    const chartTypes = [
      "bar",
      "line",
      "area",
      "pie",
      "doughnut",
      "scatter",
      "bubble",
      "radar",
    ] as const;
    chartTypes.forEach((type, index) => {
      slide.charts.add(type, {
        name: `${type}-chart`,
        position: {
          left: (index % 4) * 310,
          top: Math.floor(index / 4) * 350,
          width: 290,
          height: 330,
        },
        title: type,
        series: [
          {
            name: "Primary",
            values: [-6, 4, 12],
            xValues: [-10, 0, 20],
            bubbleSizes: [4, 16, 36],
          },
          { name: "Secondary", values: [3, 8, 5] },
        ],
        dataLabels: { showValue: true },
      });
    });
    const calls: string[] = [];
    const restoreCanvas = installRecordingCanvas(calls);
    let rendered: Awaited<ReturnType<typeof renderComponent>> | undefined;
    try {
      rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
      await flush();
      expect(calls).toContain("arc");
      expect(calls).toContain("fillRect");
      expect(calls).toContain("lineTo");
      expect(calls).toContain("closePath");
    } finally {
      await rendered?.unmount();
      restoreCanvas();
    }
  });

  test("dense table projection has a bounded level-of-detail paint", async () => {
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slide = presentation.slides.add();
    const size = 150;
    slide.tables.add({
      name: "dense-table",
      position: { left: 0, top: 0, width: 1280, height: 720 },
      rows: Array.from({ length: size }, () => Array.from({ length: size }, () => "x")),
    });
    const calls: string[] = [];
    const restoreCanvas = installRecordingCanvas(calls);
    let rendered: Awaited<ReturnType<typeof renderComponent>> | undefined;
    try {
      rendered = await renderComponent(<PresentationEditor presentation={presentation} />);
      await flush();
      expect(calls.length).toBeLessThan(1_000);
      expect(calls).toContain("lineTo");
    } finally {
      await rendered?.unmount();
      restoreCanvas();
    }
  });

  test("read-only mode preserves navigation and blocks every model mutation", async () => {
    const presentation = makePresentation(2, 2);
    const shape = presentation.slides.items[0]!.shapes.items[0]!;
    const before = { ...shape.position };
    const commits: PresentationCommit[] = [];
    const rendered = await renderComponent(
      <PresentationEditor
        presentation={presentation}
        readOnly
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    const editor = rendered.container.querySelector('[role="application"]') as SVGSVGElement;
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();

    expect(shape.position).toEqual(before);
    expect(commits).toEqual([]);
    expect(rendered.container.querySelector("textarea")).toBeNull();
    expect(rendered.container.querySelector("[data-og-presentation-object]")).toBeTruthy();

    await rendered.unmount();
  });

  test("drop-in artifact surface projects host callbacks and zoom", async () => {
    const presentation = makePresentation(3, 1);
    const slideChanges: number[] = [];
    const zoomChanges: number[] = [];
    const rendered = await renderComponent(
      <PresentationArtifactSurface
        presentation={presentation}
        title="Launch deck"
        onSlideChange={(_slide, index) => slideChanges.push(index)}
        onZoomChange={(zoom) => zoomChanges.push(zoom)}
      />,
    );
    await flush();

    expect(rendered.container.querySelector("section")?.dataset.ogArtifactModality).toBe(
      "presentation",
    );
    expect(rendered.container.textContent).toContain("Launch deck");
    const next = rendered.container.querySelector('[aria-label="Next slide"]') as HTMLButtonElement;
    await actRun(() => next.click());
    const zoomIn = rendered.container.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement;
    await actRun(() => zoomIn.click());
    await flush();

    expect(slideChanges).toEqual([1]);
    expect(zoomChanges[0]).toBeGreaterThan(0.75);
    expect(rendered.container.textContent).toContain("2 / 3");

    await rendered.unmount();
  });

  test("projection editing is optimistic, retryable, and never mutates host input", async () => {
    const makeProjection = (revision: number, left: number): PresentationEditorProjection => ({
      revision,
      slideSize: { width: 1280, height: 720 },
      slides: [
        {
          id: "host-slide-1",
          title: "Projected",
          elements: [
            {
              kind: "shape",
              id: "host-shape-1",
              name: "Projected shape",
              geometry: "textbox",
              position: { left, top: 0, width: 120, height: 40 },
              text: "Host text",
            },
          ],
        },
      ],
    });
    const original = makeProjection(1, 0);
    const commits: PresentationCommit[] = [];
    let attempt = 0;
    let resolveCommit: (() => void) | undefined;
    const rendered = await renderComponent(
      <PresentationProjectionEditor
        projection={original}
        commit={(command) => {
          commits.push(command);
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("Save rejected"));
          return new Promise<void>((resolve) => {
            resolveCommit = resolve;
          });
        }}
      />,
    );
    await flush();
    const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
    await actRun(() => editor.focus());
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();

    expect(original.slides[0]?.elements[0]?.position.left).toBe(0);
    expect(commits[0]).toMatchObject({
      kind: "move",
      slideId: "host-slide-1",
      objectId: "host-shape-1",
      after: { left: 1 },
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Save rejected",
    );
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("error");

    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await flush();
    expect(commits).toHaveLength(2);
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("pending");
    await actRun(() => resolveCommit?.());
    await flush();
    await rendered.rerender(
      <PresentationProjectionEditor projection={makeProjection(2, 1)} commit={() => {}} />,
    );
    await flush();
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("idle");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("stale async failures cannot poison a newer projection", async () => {
    const makeProjection = (revision: number, left: number): PresentationEditorProjection => ({
      revision,
      slideSize: { width: 640, height: 360 },
      slides: [
        {
          id: "slide",
          elements: [
            {
              kind: "shape",
              id: "shape",
              name: "Shape",
              geometry: "rect",
              position: { left, top: 0, width: 80, height: 40 },
              text: "",
            },
          ],
        },
      ],
    });
    let rejectCommit: ((cause: Error) => void) | undefined;
    const rendered = await renderComponent(
      <PresentationProjectionEditor
        projection={makeProjection(1, 0)}
        commit={() =>
          new Promise<void>((_resolve, reject) => {
            rejectCommit = reject;
          })
        }
      />,
    );
    await flush();
    const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("pending");

    await rendered.rerender(
      <PresentationProjectionEditor projection={makeProjection(2, 10)} commit={() => {}} />,
    );
    await flush();
    await actRun(() => rejectCommit?.(new Error("obsolete failure")));
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("idle");
    await rendered.unmount();
  });

  test("an older rejected save cannot poison a newer edit on the same projection", async () => {
    const projection: PresentationEditorProjection = {
      revision: 1,
      slideSize: { width: 640, height: 360 },
      slides: [
        {
          id: "slide",
          elements: [
            {
              kind: "shape",
              id: "shape",
              name: "Shape",
              geometry: "rect",
              position: { left: 0, top: 0, width: 80, height: 40 },
              text: "",
            },
          ],
        },
      ],
    };
    const rejectors: Array<(cause: Error) => void> = [];
    const rendered = await renderComponent(
      <PresentationProjectionEditor
        projection={projection}
        commit={() =>
          new Promise<void>((_resolve, reject) => {
            rejectors.push(reject);
          })
        }
      />,
    );
    await flush();
    const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();

    await actRun(() => rejectors[0]?.(new Error("obsolete failure")));
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      rendered.container
        .querySelector("[data-og-presentation-editor]")
        ?.getAttribute("data-og-command-state"),
    ).toBe("pending");

    await actRun(() => rejectors[1]?.(new Error("current failure")));
    await flush();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "current failure",
    );
    await rendered.unmount();
  });
});
