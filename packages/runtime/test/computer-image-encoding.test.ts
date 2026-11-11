import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { compactComputerImage, compactComputerImageContent } from "../src/computer-image-encoding";

/** A photo-like capture region that PNG compresses poorly. */
async function desktopPng(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, noise: { type: "gaussian", mean: 180, sigma: 24 } },
  })
    .png()
    .toBuffer();
}

describe("computer image encoding", () => {
  test("a PNG capture becomes a smaller JPEG with the same pixel dimensions", async () => {
    const png = await desktopPng(640, 400);
    const compacted = await compactComputerImage(png, "image/png");
    expect(compacted.mimeType).toBe("image/jpeg");
    expect(compacted.data.byteLength).toBeLessThan(png.byteLength);
    const metadata = await sharp(compacted.data).metadata();
    expect({ format: metadata.format, width: metadata.width, height: metadata.height }).toEqual({
      format: "jpeg",
      width: 640,
      height: 400,
    });
    // The same capture always encodes to the same bytes, so a replayed result
    // matches what the model saw first.
    const again = await compactComputerImage(png, "image/png");
    expect(Buffer.from(again.data).equals(Buffer.from(compacted.data))).toBe(true);
  });

  test("keeps the PNG when JPEG would not be smaller or the bytes are not a PNG", async () => {
    const tiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    expect(await compactComputerImage(tiny, "image/png")).toEqual({
      data: tiny,
      mimeType: "image/png",
    });
    const claimed = Buffer.from("not an image");
    expect(await compactComputerImage(claimed, "image/png")).toEqual({
      data: claimed,
      mimeType: "image/png",
    });
    const jpeg = await sharp(await desktopPng(64, 64))
      .jpeg()
      .toBuffer();
    expect((await compactComputerImage(jpeg, "image/jpeg")).data).toBe(jpeg);
  });

  test("re-encodes only the image items of a tool result", async () => {
    const png = (await desktopPng(320, 200)).toString("base64");
    const content = [
      { type: "text", text: "window state" },
      { type: "image", data: png, mimeType: "image/png" },
    ];
    const compacted = await compactComputerImageContent(content);
    expect(compacted[0]).toBe(content[0]);
    expect(compacted[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect((compacted[1] as { data: string }).data.length).toBeLessThan(png.length);
  });
});
