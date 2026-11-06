import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { HeifDecodeError, heifToJpeg, sniffHeifImage } from "../src/heif-image";

// A real HEVC-coded HEIC laid out like an iPhone photo: a grid of tiles plus a
// stored rotation. Made with libheif's heif-enc from a 96x64 picture whose left
// half is red and right half blue:
//   heif-enc -q 80 --cut-tiles 32 --rotate-cw 90 -o rotated-grid.heic source.png
// Shown upright it is 64x96, red on top and blue below.
const HEIC_FIXTURE = new Uint8Array(
  readFileSync(join(import.meta.dir, "fixtures/rotated-grid.heic")),
);

function ftyp(major: string, compatible: string[]): Uint8Array {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size + 8);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, "latin1"));
  return box;
}

describe("sniffHeifImage", () => {
  test("recognizes HEIC and generic HEIF brands from the ftyp box", () => {
    expect(sniffHeifImage(HEIC_FIXTURE)).toBe("HEIC");
    expect(sniffHeifImage(ftyp("mif1", ["mif1", "heic"]))).toBe("HEIC");
    expect(sniffHeifImage(ftyp("hevc", ["msf1"]))).toBe("HEIC");
    expect(sniffHeifImage(ftyp("mif1", ["mif1", "miaf"]))).toBe("HEIF");
  });

  test("rejects AVIF, other formats and truncated boxes", () => {
    expect(sniffHeifImage(ftyp("avif", ["mif1", "miaf"]))).toBeNull();
    expect(sniffHeifImage(ftyp("mif1", ["avif"]))).toBeNull();
    expect(sniffHeifImage(ftyp("isom", ["mp41"]))).toBeNull();
    expect(sniffHeifImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(sniffHeifImage(HEIC_FIXTURE.subarray(0, 12))).toBeNull();
  });
});

describe("heifToJpeg", () => {
  test("decodes a tiled, rotated HEIC upright into a JPEG", async () => {
    const jpeg = await heifToJpeg(HEIC_FIXTURE);
    expect([jpeg.width, jpeg.height]).toEqual([64, 96]);
    const metadata = await sharp(jpeg.data).metadata();
    expect(metadata.format).toBe("jpeg");
    expect([metadata.width, metadata.height]).toEqual([64, 96]);
    const { data } = await sharp(jpeg.data).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3),
    ];
    const [topRed, topGreen, topBlue] = pixel(32, 10);
    const [bottomRed, , bottomBlue] = pixel(32, 85);
    expect(topRed!).toBeGreaterThan(180);
    expect(topGreen!).toBeLessThan(80);
    expect(topBlue!).toBeLessThan(80);
    expect(bottomBlue!).toBeGreaterThan(180);
    expect(bottomRed!).toBeLessThan(80);
    // The first test also loads the decoder; a cold start can take seconds.
  }, 30_000);

  test("produces byte-identical output for the same photo", async () => {
    const [first, second] = await Promise.all([heifToJpeg(HEIC_FIXTURE), heifToJpeg(HEIC_FIXTURE)]);
    expect(Buffer.compare(first.data, second.data)).toBe(0);
  });

  test("refuses images over the pixel limit and bytes that are not HEIF", async () => {
    await expect(heifToJpeg(HEIC_FIXTURE, { maxPixels: 1000 })).rejects.toBeInstanceOf(
      HeifDecodeError,
    );
    await expect(heifToJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).rejects.toBeInstanceOf(
      HeifDecodeError,
    );
    const truncated = HEIC_FIXTURE.subarray(0, 200);
    await expect(heifToJpeg(truncated)).rejects.toBeInstanceOf(HeifDecodeError);
  });
});
