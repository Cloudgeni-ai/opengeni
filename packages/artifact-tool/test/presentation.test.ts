import { describe, expect, test } from "bun:test";

import {
  InvalidPresentationInputError,
  Presentation,
  PresentationFile,
  PresentationSecurityError,
  type PresentationShape,
  UnsupportedPresentationFeatureError,
} from "../src/presentation";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_JPEG_DATA_URL =
  "data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z";
const TINY_GIF_DATA_URL =
  "data:image/gif;base64,R0lGODlhAgADAIAAAExpcf8AACH5BAUAAAAALAAAAAACAAMAAAICjF8AOw==";
const TINY_WEBP_DATA_URL =
  "data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=";

function tinyPngBytes(): Uint8Array {
  return Uint8Array.from(atob(TINY_PNG_DATA_URL.split(",")[1]!), (character) =>
    character.charCodeAt(0),
  );
}

function oversizedRasterDataUrl(dataUrl: string): string {
  const [prefix, encoded] = dataUrl.split(",") as [string, string];
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (prefix.includes("image/png")) {
    new DataView(bytes.buffer).setUint32(16, 100_000);
    new DataView(bytes.buffer).setUint32(20, 100_000);
  } else if (prefix.includes("image/jpeg")) {
    const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
    expect(marker).toBeGreaterThan(0);
    new DataView(bytes.buffer).setUint16(marker + 5, 50_000);
    new DataView(bytes.buffer).setUint16(marker + 7, 50_000);
  } else if (prefix.includes("image/gif")) {
    new DataView(bytes.buffer).setUint16(6, 50_000, true);
    new DataView(bytes.buffer).setUint16(8, 50_000, true);
  } else {
    const marker = bytes.findIndex(
      (value, index) =>
        value === 0x56 &&
        bytes[index + 1] === 0x50 &&
        bytes[index + 2] === 0x38 &&
        bytes[index + 3] === 0x20,
    );
    expect(marker).toBeGreaterThan(0);
    const frame = marker + 8;
    new DataView(bytes.buffer).setUint16(frame + 6, 0x3fff, true);
    new DataView(bytes.buffer).setUint16(frame + 8, 0x3fff, true);
  }
  const output = btoa(String.fromCharCode(...bytes));
  return `${prefix},${output}`;
}

function samplePresentation(): Presentation {
  const presentation = Presentation.create({ slideSize: { width: 960, height: 540 } });
  const slide = presentation.slides.add();
  slide.background.fill = "slate-50";

  const headline = slide.shapes.add({
    geometry: "textbox",
    name: "headline",
    position: { left: 64, top: 48, width: 500, height: 80 },
  });
  headline.text = "Quarterly revenue";
  headline.text.style = { fontSize: 42, bold: true, color: "slate-950" };

  slide.shapes.add({
    geometry: "roundRect",
    name: "chart-frame",
    position: { left: 56, top: 148, width: 848, height: 336 },
    fill: "white",
    line: { fill: "slate-200", width: 1 },
    borderRadius: "rounded-2xl",
  });

  slide.charts.add("bar", {
    name: "arr-chart",
    title: "ARR",
    position: { left: 92, top: 176, width: 776, height: 276 },
    categories: ["Q1", "Q2", "Q3"],
    series: [{ name: "Revenue", values: [12, 18, 27], fill: "accent1" }],
    hasLegend: false,
    dataLabels: { showValue: true },
  });
  return presentation;
}

describe("presentation core", () => {
  test("creates slides and edits text through the skill-compatible proxy", async () => {
    const presentation = samplePresentation();
    expect(presentation.slides.items).toHaveLength(1);

    const before = await presentation.inspect({ kind: "textbox", search: "Quarterly" });
    expect(before.records).toHaveLength(1);
    const id = before.records[0]?.id;
    expect(typeof id).toBe("string");

    const shape = presentation.resolve<PresentationShape>(String(id));
    expect(shape.text.replace("Quarterly", "Annual")).toBe(1);
    expect(shape.text.toString()).toBe("Annual revenue");
    expect(shape.text.style).toEqual({ fontSize: 42, bold: true, color: "slate-950" });

    const after = await presentation.inspect({ target: { id: String(id) }, kind: "textbox" });
    expect(after.ndjson).toContain("Annual revenue");
    expect(presentation.resolve(String(id))).toBe(shape);
  });

  test("exports deterministic SVG, raster PNG, layout JSON, and a montage", async () => {
    const presentation = samplePresentation();
    presentation.slides.add().shapes.add({
      geometry: "textbox",
      name: "second-title",
      position: { left: 64, top: 64, width: 600, height: 100 },
      text: "Second slide",
      textStyle: { fontSize: 40, bold: true },
    });

    const first = presentation.slides.getItem(0);
    const svg = await first.export({ format: "svg" });
    expect(svg.type).toBe("image/svg+xml");
    expect(await svg.text()).toContain("Quarterly revenue");

    const png = await first.export({ format: "png", scale: 0.5 });
    const pngBytes = new Uint8Array(await png.arrayBuffer());
    expect(png.type).toBe("image/png");
    expect([...pngBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const layout = JSON.parse(await (await first.export({ format: "layout" })).text()) as {
      elements: Array<{ id: string }>;
    };
    expect(layout.elements).toHaveLength(3);
    expect(layout.elements.every((element) => element.id.includes("/"))).toBe(true);

    const montage = await presentation.export({ format: "svg", montage: true });
    const montageText = await montage.text();
    expect(montageText).toContain("Quarterly revenue");
    expect(montageText).toContain("Second slide");
    expect(montageText.match(/translate\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("adds inspectable charts and byte-backed images", async () => {
    const presentation = samplePresentation();
    const slide = presentation.slides.getItem(0);
    const image = slide.images.add({
      blob: tinyPngBytes(),
      contentType: "image/png",
      alt: "Product screenshot",
      position: { left: 700, top: 32, width: 180, height: 90 },
    });

    const snapshot = await presentation.inspect({ kind: "chart,image" });
    expect(snapshot.records.map((record) => record.kind)).toEqual(["chart", "image"]);
    expect(presentation.resolve(image.id)).toBe(image);
    expect(image.sourceForSvg()).toStartWith("data:image/png;base64,");
  });

  test("materializes blob image data once across repaints and exports", async () => {
    const bytePrototype = Uint8Array.prototype as Uint8Array & {
      toBase64?: () => string;
    };
    const descriptor = Object.getOwnPropertyDescriptor(bytePrototype, "toBase64");
    const nativeToBase64 = bytePrototype.toBase64;
    expect(nativeToBase64).toBeFunction();

    let materializations = 0;
    Object.defineProperty(bytePrototype, "toBase64", {
      configurable: true,
      writable: true,
      value(this: Uint8Array) {
        materializations += 1;
        return nativeToBase64!.call(this);
      },
    });

    try {
      const presentation = Presentation.create({
        imageResolver: async () => ({ blob: tinyPngBytes(), contentType: "image/png" }),
        allowedImageUriSchemes: ["asset"],
      });
      const slide = presentation.slides.add();
      const image = slide.images.add({ blob: tinyPngBytes(), contentType: "image/png" });

      expect(materializations).toBe(0);
      const canonical = image.sourceForSvg();
      expect(materializations).toBe(1);

      // Canvas paint calls sourceForSvg on every frame; exports validate and read it again.
      for (let frame = 0; frame < 100; frame += 1) {
        expect(image.sourceForSvg()).toBe(canonical);
      }
      await slide.export({ format: "svg" });
      await slide.export({ format: "svg" });
      expect(materializations).toBe(1);

      // Public MIME mutation must still fail closed before a cached source is returned.
      image.contentType = "image/jpeg";
      expect(() => image.sourceForSvg()).toThrow(InvalidPresentationInputError);
      expect(materializations).toBe(1);
      image.contentType = "image/png";
      expect(image.sourceForSvg()).toBe(canonical);

      // Every concrete source transition invalidates the memoized representation.
      image.replace({ uri: "asset:replacement" });
      expect(() => image.sourceForSvg()).toThrow(UnsupportedPresentationFeatureError);
      await image.resolveUri();
      expect(materializations).toBe(1);
      const replacement = image.sourceForSvg();
      expect(replacement).toStartWith("data:image/png;base64,");
      expect(materializations).toBe(2);
      expect(image.sourceForSvg()).toBe(replacement);
      expect(materializations).toBe(2);
    } finally {
      if (descriptor) {
        Object.defineProperty(bytePrototype, "toBase64", descriptor);
      } else {
        Reflect.deleteProperty(bytePrototype, "toBase64");
      }
    }
  });

  test("exports a real editable PPTX package", async () => {
    const pptx = await PresentationFile.exportPptx(samplePresentation());
    expect(pptx.type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    const bytes = new Uint8Array(await pptx.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  test("exports WebP and rejects malformed PPTX input", async () => {
    const webp = await samplePresentation().export({ format: "webp", montage: true });
    const webpBytes = new Uint8Array(await webp.arrayBuffer());
    expect(new TextDecoder().decode(webpBytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(webpBytes.subarray(8, 12))).toBe("WEBP");
    await expect(PresentationFile.importPptx(new Blob())).rejects.toBeInstanceOf(
      PresentationSecurityError,
    );
  });

  test("rejects active, external, malformed, and MIME-confused image sources", () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();

    expect(() => slide.images.add({ uri: "file:///etc/passwd" })).toThrow(
      InvalidPresentationInputError,
    );
    expect(() =>
      Presentation.create({
        imageResolver: async () => ({ blob: tinyPngBytes(), contentType: "image/png" }),
        allowedImageUriSchemes: ["https"],
      }),
    ).toThrow(InvalidPresentationInputError);
    expect(() =>
      slide.images.add({ dataUrl: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9J2FsZXJ0KDEpJy8+" }),
    ).toThrow(InvalidPresentationInputError);
    expect(() => slide.images.add({ blob: tinyPngBytes(), contentType: "image/jpeg" })).toThrow(
      InvalidPresentationInputError,
    );
    expect(() =>
      slide.images.add({ dataUrl: TINY_PNG_DATA_URL.replace("image/png", "image/jpeg") }),
    ).toThrow(InvalidPresentationInputError);
  });

  test("preflights decoded dimensions for PNG, JPEG, GIF, and WebP", () => {
    const safeSlide = Presentation.create().slides.add();
    for (const dataUrl of [
      TINY_PNG_DATA_URL,
      TINY_JPEG_DATA_URL,
      TINY_GIF_DATA_URL,
      TINY_WEBP_DATA_URL,
    ]) {
      expect(() => safeSlide.images.add({ dataUrl })).not.toThrow();
    }

    for (const dataUrl of [
      TINY_PNG_DATA_URL,
      TINY_JPEG_DATA_URL,
      TINY_GIF_DATA_URL,
      TINY_WEBP_DATA_URL,
    ]) {
      const slide = Presentation.create().slides.add();
      expect(() => slide.images.add({ dataUrl: oversizedRasterDataUrl(dataUrl) })).toThrow(
        /dimension|pixel|limit/i,
      );
    }

    for (const dataUrl of [
      TINY_PNG_DATA_URL,
      TINY_JPEG_DATA_URL,
      TINY_GIF_DATA_URL,
      TINY_WEBP_DATA_URL,
    ]) {
      const [prefix, encoded] = dataUrl.split(",") as [string, string];
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const truncated = btoa(String.fromCharCode(...bytes.subarray(0, -1)));
      const slide = Presentation.create().slides.add();
      expect(() => slide.images.add({ dataUrl: `${prefix},${truncated}` })).toThrow(/malformed/i);
    }
  });

  test("rejects raster output whose scaled canvas exceeds the pixel budget", async () => {
    const hugeSlide = Presentation.create({
      slideSize: { width: 100_000, height: 100_000 },
    }).slides.add();
    await expect(hugeSlide.export({ format: "png" })).rejects.toBeInstanceOf(
      InvalidPresentationInputError,
    );

    const scaledSlide = Presentation.create({
      slideSize: { width: 8_192, height: 8_192 },
    }).slides.add();
    await expect(scaledSlide.export({ format: "webp", scale: 2 })).rejects.toThrow(
      /dimension|pixel|limit/i,
    );

    const montage = Presentation.create({ slideSize: { width: 8_192, height: 8_192 } });
    montage.slides.add();
    montage.slides.add();
    await expect(montage.export({ format: "png", montage: true })).rejects.toThrow(
      /dimension|pixel|limit/i,
    );
  });

  test("never resolves a host image implicitly and validates explicit resolver output", async () => {
    let calls = 0;
    const presentation = Presentation.create({
      imageResolver: async ({ uri }) => {
        calls += 1;
        expect(uri).toBe("asset:hero-image");
        return { blob: tinyPngBytes(), contentType: "image/png" };
      },
      allowedImageUriSchemes: ["asset"],
    });
    const slide = presentation.slides.add();
    const image = slide.images.add({ uri: "asset:hero-image", alt: "Hero" });

    await expect(slide.export({ format: "svg" })).rejects.toBeInstanceOf(
      UnsupportedPresentationFeatureError,
    );
    await expect(PresentationFile.exportPptx(presentation)).rejects.toBeInstanceOf(
      UnsupportedPresentationFeatureError,
    );
    expect(calls).toBe(0);

    await image.resolveUri();
    expect(calls).toBe(1);
    const svg = await (await slide.export({ format: "svg" })).text();
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).not.toContain("asset:hero-image");
  });

  test("escapes safe text attributes and rejects executable SVG attribute values", async () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();
    slide.shapes.add({
      geometry: "textbox",
      text: '<script>alert("x")</script>',
      textStyle: { fontFamily: 'Arial" onload="alert(1)' },
    });

    const svg = await (await slide.export({ format: "svg" })).text();
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('onload="alert');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot; onload=&quot;");

    expect(() => slide.shapes.add({ geometry: "rect", fill: '#fff" onload="alert(1)' })).toThrow(
      InvalidPresentationInputError,
    );
    expect(() =>
      slide.shapes.add({
        geometry: "rect",
        line: { fill: "url(javascript:alert(1))" },
      }),
    ).toThrow(InvalidPresentationInputError);
    expect(() => slide.shapes.add({ geometry: "foreignObject" as never })).toThrow(
      InvalidPresentationInputError,
    );
  });
});
