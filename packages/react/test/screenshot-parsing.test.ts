import { describe, expect, test } from "bun:test";
import { mediaPreviewFact, screenshotDataUrl } from "../src/timeline/parsers";

// A 1x1 PNG's first bytes are enough for the extractor (it never decodes).
const BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
const B64 = Buffer.from(Uint8Array.from(BYTES)).toString("base64");

describe("screenshotDataUrl — every computer-use transport shape", () => {
  test("hosted / function-text: plain data URL passes through", () => {
    expect(screenshotDataUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  test("non-image strings return null", () => {
    expect(screenshotDataUrl("clicked left at (3, 4)")).toBeNull();
    expect(screenshotDataUrl("")).toBeNull();
    expect(screenshotDataUrl(null)).toBeNull();
  });

  test("function-image: structured output with number-array bytes", () => {
    const out = { type: "image", image: { data: BYTES, mediaType: "image/png" } };
    expect(screenshotDataUrl(out)).toBe(`data:image/png;base64,${B64}`);
  });

  test("function-image: Buffer-JSON bytes", () => {
    const out = {
      type: "image",
      image: { data: { type: "Buffer", data: BYTES }, mediaType: "image/png" },
    };
    expect(screenshotDataUrl(out)).toBe(`data:image/png;base64,${B64}`);
  });

  test("function-image: index-map bytes (Uint8Array JSON.stringify)", () => {
    const data = Object.fromEntries(BYTES.map((b, i) => [String(i), b]));
    const out = { type: "image", image: { data, mediaType: "image/png" } };
    expect(screenshotDataUrl(out)).toBe(`data:image/png;base64,${B64}`);
  });

  test("agents-core normalized input_image content item (string and {url})", () => {
    expect(screenshotDataUrl({ type: "input_image", image_url: "data:image/png;base64,AA" })).toBe(
      "data:image/png;base64,AA",
    );
    expect(
      screenshotDataUrl([{ type: "input_image", image_url: { url: "data:image/png;base64,BB" } }]),
    ).toBe("data:image/png;base64,BB");
  });

  test("JSON-stringified structured output", () => {
    const out = JSON.stringify({ type: "image", image: { data: BYTES, mediaType: "image/png" } });
    expect(screenshotDataUrl(out)).toBe(`data:image/png;base64,${B64}`);
  });
});

describe("mediaPreviewFact", () => {
  const preview = {
    type: "media_preview" as const,
    mediaType: "image/png",
    inlineBytes: 2_000_000,
    fullOutputAvailable: false as const,
    preview: "Inline media omitted from the audit timeline; source bytes were not retained.",
  };

  test("finds direct, mixed-array, and JSON-encoded non-retained media facts", () => {
    expect(mediaPreviewFact(preview)).toEqual(preview);
    expect(mediaPreviewFact([{ type: "text", text: "visible" }, preview])).toEqual(preview);
    expect(mediaPreviewFact(JSON.stringify(preview))).toEqual(preview);
  });

  test("does not treat legacy renderable image data or malformed facts as omitted media", () => {
    expect(mediaPreviewFact("data:image/png;base64,AAAA")).toBeNull();
    expect(mediaPreviewFact({ ...preview, fullOutputAvailable: true })).toBeNull();
    expect(screenshotDataUrl(preview)).toBeNull();
  });
});
