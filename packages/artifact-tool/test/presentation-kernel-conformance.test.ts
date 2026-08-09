import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Presentation } from "../src/presentation";

const fixturePath = join(import.meta.dir, "fixtures", "presentation-kernel-v1.txt");

describe("presentation native semantic conformance vector", () => {
  test("TypeScript reference facade emits the checked-in minimal deck vector", async () => {
    const presentation = Presentation.create();
    const master = presentation.masters.add({ name: "Master" });
    const layout = presentation.layouts.add({ name: "Layout", masterId: master.id });
    const slide = presentation.slides.add();
    slide.setLayout(layout);
    const shape = slide.shapes.add({
      geometry: "textbox",
      name: "Greeting",
      position: { left: 10, top: 20, width: 30, height: 40 },
      text: "Hello",
    });
    const vector = [
      `deck|pr/1|${presentation.slideSize.width}|${presentation.slideSize.height}`,
      `master|${master.id}|${master.name}`,
      `layout|${layout.id}|${layout.name}|${layout.masterId}`,
      `slide|${slide.id}|${slide.title}|${slide.layout?.id}`,
      `textbox|${shape.id}|${shape.name}|${shape.position.left}|${shape.position.top}|${shape.position.width}|${shape.position.height}|${shape.text.toString()}`,
      "",
    ].join("\n");
    expect(vector).toBe(await Bun.file(fixturePath).text());
  });
});
