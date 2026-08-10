import { describe, expect, test } from "bun:test";
import {
  LatestBrowserFrameSubscription,
  decodeBoundedBase64Image,
  imageDimensions,
  normalizeFrameStreamOptions,
  type BrowserImageFrame,
} from "../src";

describe("browser media", () => {
  test("validates image payloads and dimensions", () => {
    const png = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2,
    ]);
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9,
    ]);

    expect(imageDimensions(png, "png")).toEqual({ width: 3, height: 2 });
    expect(imageDimensions(jpeg, "jpeg")).toEqual({ width: 3, height: 2 });
    expect(decodeBoundedBase64Image(Buffer.from(png).toString("base64"))).toEqual(png);
    expect(() => decodeBoundedBase64Image("not base64")).toThrow("invalid base64");
  });

  test("normalizes a bounded stream configuration", () => {
    expect(normalizeFrameStreamOptions()).toEqual({
      format: "jpeg",
      quality: 70,
      maxWidth: 1_440,
      maxHeight: 900,
      everyNthFrame: 1,
    });
    expect(() => normalizeFrameStreamOptions({ maxWidth: 10_000 })).toThrow("bounded integer");
  });

  test("keeps only the newest unread frame and closes exactly once", async () => {
    let closes = 0;
    const subscription = new LatestBrowserFrameSubscription(async () => {
      closes += 1;
    });
    subscription.push(frame(1));
    subscription.push(frame(2));
    expect(await subscription.next()).toMatchObject({ done: false, value: { sequence: 2 } });

    const pending = subscription.next();
    await expect(subscription.next()).rejects.toThrow("pending read");
    subscription.push(frame(3));
    expect(await pending).toMatchObject({ done: false, value: { sequence: 3 } });

    const ending = subscription.next();
    await Promise.all([subscription.close(), subscription.close()]);
    expect(await ending).toEqual({ done: true, value: undefined });
    expect(closes).toBe(1);
  });
});

function frame(sequence: number): BrowserImageFrame {
  return {
    frameId: `frame-${sequence}`,
    browserSessionId: "10000000-0000-4000-8000-000000000001",
    controllerGeneration: "controller-1",
    targetId: "target-1",
    targetGeneration: "target-generation-1",
    documentGeneration: "document-generation-1",
    sequence,
    mediaType: "image/jpeg",
    width: 1,
    height: 1,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
    data: Uint8Array.of(1),
    capturedAt: "2026-08-09T12:00:00.000Z",
  };
}
