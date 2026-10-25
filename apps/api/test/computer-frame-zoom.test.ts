import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  captureZoomedComputerFrame,
  decodeZoomedFrameId,
  parseComputerFrameRegionQuery,
  translateZoomedComputerAction,
  zoomedFrameId,
} from "../src/computer-frame-zoom";

const NATIVE = { width: 2_560, height: 1_410 };

/** A white native window with one red 100x100 square at 2000,100. */
async function nativeWindow(width: number, height: number): Promise<Buffer> {
  const square = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  return await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([{ input: square, left: 2_000, top: 100 }])
    .png()
    .toBuffer();
}

function fakeClient(generations: string[] = ["g1", "g1"]) {
  const requests: Array<{ maxWidth?: number; maxHeight?: number }> = [];
  return {
    requests,
    capture: async (
      targetId: string,
      options: { format?: "jpeg" | "png"; maxWidth?: number; maxHeight?: number },
    ) => {
      requests.push({ maxWidth: options.maxWidth, maxHeight: options.maxHeight });
      const scale = Math.min(
        1,
        (options.maxWidth ?? 4_096) / NATIVE.width,
        (options.maxHeight ?? 4_096) / NATIVE.height,
      );
      const width = Math.round(NATIVE.width * scale);
      const height = Math.round(NATIVE.height * scale);
      const data = new Uint8Array(
        await sharp(await nativeWindow(NATIVE.width, NATIVE.height))
          .resize(width, height)
          .png()
          .toBuffer(),
      );
      const metadata = {
        frameId: `session-1:capture-${requests.length}`,
        computerSessionId: "00000000-0000-4000-8000-000000000001",
        controllerGeneration: "controller-1",
        targetId,
        targetGeneration: generations[requests.length - 1]!,
        sequence: 0,
        mediaType: "image/png" as const,
        width,
        height,
        capturedAt: "2026-10-25T16:00:00.000Z",
        sha256: "0".repeat(64),
      };
      return { data, mediaType: "image/png" as const, metadataHeader: "x", metadata };
    },
  };
}

describe("zoomed computer frames", () => {
  test("parses a region query", () => {
    expect(parseComputerFrameRegionQuery(undefined)).toBeNull();
    expect(parseComputerFrameRegionQuery("800,40,40.5,40")).toEqual({
      x: 800,
      y: 40,
      width: 40.5,
      height: 40,
    });
    for (const bad of ["", "1,2,3", "1,2,3,4,5", "a,2,3,4", "-1,0,3,4", "0,0,0,4", "0,,3,4"]) {
      expect(() => parseComputerFrameRegionQuery(bad)).toThrow();
    }
  });

  test("a zoomed frame ID carries its crop and size, and nothing else decodes", () => {
    const id = zoomedFrameId({
      baseFrameId: "session-1:capture-2",
      crop: { x: 2_000, y: 100, width: 100, height: 100 },
      output: { width: 100, height: 100 },
    });
    expect(id).toBe("session-1:capture-2:zoom.2000.100.100.100.100.100");
    expect(decodeZoomedFrameId(id)).toEqual({
      baseFrameId: "session-1:capture-2",
      crop: { x: 2_000, y: 100, width: 100, height: 100 },
      output: { width: 100, height: 100 },
    });
    expect(decodeZoomedFrameId("session-1:capture-2")).toBeNull();
    expect(decodeZoomedFrameId("a:zoom.1.2.0.4.5.6")).toBeNull();
    expect(() =>
      zoomedFrameId({
        baseFrameId: "x".repeat(250),
        crop: { x: 0, y: 0, width: 1, height: 1 },
        output: { width: 1, height: 1 },
      }),
    ).toThrow("cannot zoom");
  });

  test("pointer actions on a zoomed frame land in the native frame's pixels", () => {
    const frameId = "session-1:capture-2:zoom.1600.0.960.1410.760.1116";
    const translated = translateZoomedComputerAction({
      expectedFrameId: frameId,
      action: { type: "pointer", frameId, action: "drag", x: 380, y: 558, endX: 0, endY: 0 },
    });
    expect(translated).toEqual({
      expectedFrameId: "session-1:capture-2",
      action: {
        type: "pointer",
        frameId: "session-1:capture-2",
        action: "drag",
        x: 1_600 + (380 * 960) / 760,
        y: (558 * 1_410) / 1_116,
        endX: 1_600,
        endY: 0,
      },
    });
    expect(() =>
      translateZoomedComputerAction({
        expectedFrameId: null,
        action: { type: "pointer", frameId, action: "click", x: 760, y: 10 },
      }),
    ).toThrow("outside the 760x1116 zoomed screenshot");
    // Ordinary frames and other actions pass through unchanged.
    const plain = {
      expectedFrameId: "session-1:capture-2",
      action: { type: "pointer", frameId: "session-1:capture-2", action: "click", x: 5, y: 5 },
    };
    expect(translateZoomedComputerAction(plain)).toBe(plain);
    const keyboard = { expectedFrameId: null, action: { type: "keyboard", key: "Enter" } };
    expect(translateZoomedComputerAction(keyboard)).toBe(keyboard);
  });

  test("zooms a rectangle of the regular screenshot at native resolution", async () => {
    const client = fakeClient();
    // The red square is at 2000,100 native = 800,40 in the 1024x564 screenshot.
    const zoomed = await captureZoomedComputerFrame(
      client,
      "cua:window:1:2",
      { x: 800, y: 40, width: 40, height: 40 },
      256 * 1024,
      (frame) => frame,
    );
    expect(client.requests).toEqual([
      { maxWidth: 1_024, maxHeight: 768 },
      { maxWidth: 4_096, maxHeight: 4_096 },
    ]);
    expect(zoomed.mediaType).toBe("image/jpeg");
    expect(zoomed.metadata).toMatchObject({
      frameId: "session-1:capture-2:zoom.2000.100.100.100.100.100",
      width: 100,
      height: 100,
      region: { x: 800, y: 40, width: 40, height: 40 },
      targetGeneration: "g1",
    });
    expect(JSON.parse(Buffer.from(zoomed.metadataHeader, "base64url").toString())).toEqual(
      zoomed.metadata,
    );
    const { data, info } = await sharp(zoomed.data).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(100);
    const center = (50 * 100 + 50) * info.channels;
    expect(data[center]!).toBeGreaterThan(230);
    expect(data[center + 1]!).toBeLessThan(30);
    // A click at the zoomed square's centre lands at the square's native centre.
    const click = translateZoomedComputerAction({
      expectedFrameId: null,
      action: { type: "pointer", frameId: zoomed.metadata.frameId, action: "click", x: 50, y: 50 },
    });
    expect(click.action).toMatchObject({ frameId: "session-1:capture-2", x: 2_050, y: 150 });
  });

  test("keeps a large zoom within the model's image bounds and clips to the screenshot", async () => {
    const zoomed = await captureZoomedComputerFrame(
      fakeClient(),
      "cua:window:1:2",
      { x: 0, y: 0, width: 5_000, height: 5_000 },
      256 * 1024,
      (frame) => frame,
    );
    expect(zoomed.metadata.region).toEqual({ x: 0, y: 0, width: 1_024, height: 564 });
    expect(Math.max(zoomed.metadata.width, zoomed.metadata.height)).toBeLessThanOrEqual(1_568);
    expect(zoomed.metadata.width * zoomed.metadata.height).toBeLessThanOrEqual(1_150_000);
    expect(zoomed.data.byteLength).toBeLessThanOrEqual(256 * 1024);
    await expect(
      captureZoomedComputerFrame(
        fakeClient(),
        "cua:window:1:2",
        { x: 2_000, y: 0, width: 10, height: 10 },
        256 * 1024,
        (frame) => frame,
      ),
    ).rejects.toThrow("outside the 1024x564 screenshot");
  });

  test("refuses a zoom when the window changed between its two captures", async () => {
    await expect(
      captureZoomedComputerFrame(
        fakeClient(["g1", "g2"]),
        "cua:window:1:2",
        { x: 0, y: 0, width: 10, height: 10 },
        256 * 1024,
        (frame) => frame,
      ),
    ).rejects.toThrow("changed while it was being zoomed");
  });
});
