import { describe, expect, test } from "bun:test";
import {
  elideStaleScreenshotImages,
  SCREENSHOT_OMITTED_IMAGE_DATA_URL,
  SCREENSHOT_OMITTED_PLACEHOLDER,
} from "../src/index";

const image = (id: number) => `data:image/png;base64,${Buffer.from(`frame-${id}`).toString("base64")}`;
const computerImages = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNg+M/wHwAEAQH/rrVV9QAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/OSkZvgAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4/5/hPwAH/QL+ecrXpAAAAABJRU5ErkJggg==",
] as const;
const PNG_SIGNATURE = "89504e470d0a1a0a";

function expectPngDataUrl(value: unknown): asserts value is string {
  expect(value).toBeString();
  expect(value).toMatch(/^data:image\/png;base64,/);
  const base64 = (value as string).slice("data:image/png;base64,".length);
  expect(Buffer.from(base64, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
}

describe("elideStaleScreenshotImages", () => {
  test("keeps the last three image payloads across all supported shapes", () => {
    const input = [
      { type: "computer_call_result", callId: "cu_1", output: { type: "computer_screenshot", data: image(1) } },
      { type: "computer_call_output", call_id: "cu_2", output: { type: "computer_screenshot", image_url: image(2) } },
      { type: "function_call_result", callId: "fn_1", output: [{ type: "input_image", image: image(3) }] },
      { type: "function_call_result", callId: "fn_2", output: { type: "text", text: image(4) } },
      { type: "function_call_result", callId: "fn_3", output: image(5) },
    ] as any[];

    const out = elideStaleScreenshotImages(input);

    expect(out.imageCount).toBe(5);
    expect(out.elidedCount).toBe(2);
    expect((out.items[0] as any).output.data).toBe(SCREENSHOT_OMITTED_IMAGE_DATA_URL);
    expect((out.items[1] as any).output.image_url).toBe(SCREENSHOT_OMITTED_IMAGE_DATA_URL);
    expect((out.items[2] as any).output[0].image).toBe(image(3));
    expect((out.items[3] as any).output.text).toBe(image(4));
    expect((out.items[4] as any).output).toBe(image(5));
  });

  test("replaces stale computer screenshots with a valid PNG data URL card", () => {
    const input = [
      { type: "computer_call_output", call_id: "cu_1", output: { type: "computer_screenshot", image_url: image(1) } },
      { type: "computer_call_output", call_id: "cu_2", output: { type: "computer_screenshot", image_url: image(2) } },
      { type: "computer_call_output", call_id: "cu_3", output: { type: "computer_screenshot", image_url: image(3) } },
      { type: "computer_call_output", call_id: "cu_4", output: { type: "computer_screenshot", image_url: image(4) } },
    ] as any[];

    const out = elideStaleScreenshotImages(input);

    expect(out.elidedCount).toBe(1);
    expect((out.items[0] as any).output.image_url).toBe(SCREENSHOT_OMITTED_IMAGE_DATA_URL);
    expectPngDataUrl((out.items[0] as any).output.image_url);
  });

  test("replaces stale structured input_image items with input_text placeholders", () => {
    const input = [
      { type: "function_call_result", callId: "old_1", output: [{ type: "input_image", image: image(1) }] },
      { type: "function_call_result", callId: "old_2", output: [{ type: "input_image", imageUrl: image(2) }] },
      { type: "function_call_result", callId: "keep_1", output: [{ type: "input_image", image_url: image(3) }] },
      { type: "function_call_result", callId: "keep_2", output: [{ type: "input_image", image: image(4) }] },
    ] as any[];

    const out = elideStaleScreenshotImages(input);

    expect(out.elidedCount).toBe(1);
    expect((out.items[0] as any).output[0]).toEqual({
      type: "input_text",
      text: SCREENSHOT_OMITTED_PLACEHOLDER,
    });
    expect((out.items[1] as any).output[0]).toEqual({ type: "input_image", imageUrl: image(2) });
    expect((out.items[2] as any).output[0]).toEqual({ type: "input_image", image_url: image(3) });
    expect((out.items[3] as any).output[0]).toEqual({ type: "input_image", image: image(4) });
  });

  test("does not touch user/system messages or non-image tool outputs", () => {
    const user = { type: "message", role: "user", content: [{ type: "input_image", image: image(1) }] };
    const system = { type: "message", role: "system", content: image(2) };
    const textTool = { type: "function_call_result", callId: "fn_text", output: { type: "text", text: "plain output" } };
    const input = [
      user,
      system,
      textTool,
      { type: "function_call_result", callId: "fn_1", output: image(3) },
      { type: "function_call_result", callId: "fn_2", output: image(4) },
      { type: "function_call_result", callId: "fn_3", output: image(5) },
      { type: "function_call_result", callId: "fn_4", output: image(6) },
    ] as any[];

    const out = elideStaleScreenshotImages(input);

    expect(out.imageCount).toBe(4);
    expect(out.elidedCount).toBe(1);
    expect(out.items[0]).toEqual(user);
    expect(out.items[1]).toEqual(system);
    expect(out.items[2]).toEqual(textTool);
    expect((out.items[3] as any).output).toBe(SCREENSHOT_OMITTED_PLACEHOLDER);
    expect((out.items[4] as any).output).toBe(image(4));
    expect((out.items[5] as any).output).toBe(image(5));
    expect((out.items[6] as any).output).toBe(image(6));
  });

  test("keeps all computer_call_output image_url values valid after eliding four screenshots", () => {
    const input = [
      { type: "computer_call_output", call_id: "cu_1", output: { type: "computer_screenshot", image_url: computerImages[0] } },
      { type: "computer_call_output", call_id: "cu_2", output: { type: "computer_screenshot", image_url: computerImages[1] } },
      { type: "computer_call_output", call_id: "cu_3", output: { type: "computer_screenshot", image_url: computerImages[2] } },
      { type: "computer_call_output", call_id: "cu_4", output: { type: "computer_screenshot", image_url: computerImages[3] } },
    ] as any[];

    const out = elideStaleScreenshotImages(input);
    const urls = out.items.map((item) => (item as any).output.image_url);

    expect(out.imageCount).toBe(4);
    expect(out.elidedCount).toBe(1);
    expect(urls).toEqual([
      SCREENSHOT_OMITTED_IMAGE_DATA_URL,
      computerImages[1],
      computerImages[2],
      computerImages[3],
    ]);
    for (const url of urls) {
      expectPngDataUrl(url);
    }
  });

  test("can be configured to keep zero images", () => {
    const input = [
      { type: "function_call_result", callId: "fn_1", output: image(1) },
      { type: "function_call_result", callId: "fn_2", output: image(2) },
    ] as any[];

    const out = elideStaleScreenshotImages(input, { keepLast: 0 });

    expect(out.elidedCount).toBe(2);
    expect((out.items[0] as any).output).toBe(SCREENSHOT_OMITTED_PLACEHOLDER);
    expect((out.items[1] as any).output).toBe(SCREENSHOT_OMITTED_PLACEHOLDER);
  });
});
