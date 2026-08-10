import { describe, expect, test } from "bun:test";

import { InvalidSpreadsheetImageError, Workbook } from "../src/spreadsheet";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z";
const TINY_GIF =
  "data:image/gif;base64,R0lGODlhAgADAIAAAExpcf8AACH5BAUAAAAALAAAAAACAAMAAAICjF8AOw==";
const TINY_WEBP =
  "data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=";

function oversizedRasterDataUrl(dataUrl: string): string {
  const [prefix, encoded] = dataUrl.split(",") as [string, string];
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (prefix.includes("image/png")) {
    new DataView(bytes.buffer).setUint32(16, 100_000);
    new DataView(bytes.buffer).setUint32(20, 100_000);
  } else if (prefix.includes("image/jpeg")) {
    const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
    if (marker < 0) throw new Error("JPEG fixture has no frame header");
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
    if (marker < 0) throw new Error("WebP fixture has no frame header");
    const frame = marker + 8;
    new DataView(bytes.buffer).setUint16(frame + 6, 0x3fff, true);
    new DataView(bytes.buffer).setUint16(frame + 8, 0x3fff, true);
  }
  return `${prefix},${btoa(String.fromCharCode(...bytes))}`;
}

function largeValidPngBytes(): Uint8Array<ArrayBuffer> {
  const encoded = ONE_PIXEL_PNG.slice(ONE_PIXEL_PNG.indexOf(",") + 1);
  const source = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let iendOffset = 8;
  while (iendOffset < source.length) {
    const length = sourceView.getUint32(iendOffset);
    const type = String.fromCharCode(...source.subarray(iendOffset + 4, iendOffset + 8));
    if (type === "IEND") break;
    iendOffset += length + 12;
  }
  if (iendOffset >= source.length) throw new Error("PNG fixture has no IEND chunk");

  const text = new Uint8Array(1024 * 1024);
  text.fill(0x61);
  text.set([0x6e, 0x6f, 0x74, 0x65, 0]);
  const chunk = new Uint8Array(text.length + 12);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, text.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);
  chunk.set(text, 8);
  chunkView.setUint32(text.length + 8, pngCrc32(chunk, 4, text.length + 8));

  const output = new Uint8Array(source.length + chunk.length);
  output.set(source.subarray(0, iendOffset));
  output.set(chunk, iendOffset);
  output.set(source.subarray(iendOffset), iendOffset + chunk.length);
  return output;
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

describe("spreadsheet rendering", () => {
  test("renders deterministic styled SVG with escaped values and merges", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Revenue & margin");
    sheet.getRange("A1:C3").values = [
      ["Q1 <plan>", "Revenue", "Margin"],
      ["Jan", 120, 0.25],
      ["Long text wraps cleanly", 180, 0.3],
    ];
    sheet.getRange("A1:C1").format = {
      fill: "#123456",
      font: { bold: true, color: "#ffffff" },
      borders: { preset: "doubleBottom", color: "#0f172a" },
    };
    sheet.getRange("A3").format = { wrapText: true, verticalAlignment: "top" };
    sheet.getRange("B2:B3").format.numberFormat = "$#,##0";
    sheet.getRange("C2:C3").format.numberFormat = "0.0%";
    sheet.getRange("A1:B1").merge();
    sheet.getRange("A1:C3").format.columnWidthPx = 110;

    const first = await workbook.render({
      sheetName: sheet.name,
      range: "A1:C3",
      format: "svg",
    });
    const second = await workbook.render({
      sheetName: sheet.name,
      range: "A1:C3",
      format: "svg",
    });
    const svg = await first.text();

    expect(first.type).toBe("image/svg+xml");
    expect(first.name).toBe("Revenue-margin.svg");
    expect(svg).toBe(await second.text());
    expect(svg).toContain("Q1 &lt;plan&gt;");
    expect(svg).toContain("$120");
    expect(svg).toContain("25.0%");
    expect(svg).toContain('font-weight="700"');
    expect(svg).not.toContain("<plan>");
  });

  test("rasterizes the same model to a real PNG", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Summary");
    sheet.getRange("A1:B2").values = [
      ["Metric", "Value"],
      ["ARR", 42],
    ];

    const png = await workbook.render({ sheetName: "Summary", format: "png", scale: 1.5 });
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect(png.type).toBe("image/png");
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  test("includes positioned editable charts in the retained scene", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Dashboard");
    sheet.getRange("A1:B4").values = [
      ["Month", "Revenue"],
      ["Jan", 100],
      ["Feb", 140],
      ["Mar", 180],
    ];
    const chart = sheet.charts.add("bar", sheet.getRange("A1:B4"));
    chart.title = "Revenue trend";
    chart.setPosition("D1", "J12");

    const svg = await (await workbook.render({ format: "svg" })).text();
    expect(svg).toContain(`data-opengeni-chart="${chart.id}"`);
    expect(svg).toContain("Revenue trend");
    expect(svg).toContain("<rect");
  });

  test("rejects unbounded renders before allocating a giant scene", async () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Summary");
    await expect(
      workbook.render({ sheetName: "Summary", range: "A1:XFD1048576", format: "svg" }),
    ).rejects.toThrow("maximum");
  });

  test("fails closed on unsafe image sources before render", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Unsafe");
    expect(() =>
      sheet.images.add({
        dataUrl: "data:image/svg+xml,<svg onload='alert(1)'/>",
        anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
      }),
    ).toThrow(InvalidSpreadsheetImageError);
    expect(sheet.images.items).toHaveLength(0);
  });

  test("fails closed during render if runtime code bypasses the image collection", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Unsafe");
    const items = sheet.images.items as unknown as Array<{
      config: {
        dataUrl: string;
        anchor: {
          from: { row: number; col: number };
          extent: { widthPx: number; heightPx: number };
        };
      };
    }>;
    items.push({
      config: {
        dataUrl: "https://example.invalid/tracker.png",
        anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
      },
    });

    await expect(workbook.render({ format: "svg" })).rejects.toBeInstanceOf(
      InvalidSpreadsheetImageError,
    );
  });

  test("renders valid raster data URLs and byte inputs without reusing mutable input", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Images");
    const encoded = ONE_PIXEL_PNG.slice(ONE_PIXEL_PNG.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    sheet.images.add({
      dataUrl: ONE_PIXEL_PNG,
      anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
    });
    sheet.images.add({
      blob: bytes.buffer,
      contentType: "image/png",
      anchor: { from: { row: 1, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
    });
    bytes.fill(0);

    const svg = await (await workbook.render({ format: "svg", range: "A1:A2" })).text();
    expect(svg.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(svg).not.toContain("<script");
  });

  test("rejects raster MIME and byte signature mismatches", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Images");
    expect(() =>
      sheet.images.add({
        dataUrl: ONE_PIXEL_PNG.replace("image/png", "image/jpeg"),
        anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
      }),
    ).toThrow(InvalidSpreadsheetImageError);
  });

  test("preflights complete raster structure and decoded dimensions for every MIME", () => {
    const dataUrls = [ONE_PIXEL_PNG, TINY_JPEG, TINY_GIF, TINY_WEBP];
    const safeSheet = Workbook.create().worksheets.add("Safe");
    for (const dataUrl of dataUrls) {
      expect(() =>
        safeSheet.images.add({
          dataUrl,
          anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
        }),
      ).not.toThrow();
    }

    for (const dataUrl of dataUrls) {
      const sheet = Workbook.create().worksheets.add("Oversized");
      expect(() =>
        sheet.images.add({
          dataUrl: oversizedRasterDataUrl(dataUrl),
          anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
        }),
      ).toThrow(/dimension|pixel|limit/i);

      const [prefix, encoded] = dataUrl.split(",") as [string, string];
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const truncated = btoa(String.fromCharCode(...bytes.subarray(0, -1)));
      expect(() =>
        sheet.images.add({
          dataUrl: `${prefix},${truncated}`,
          anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
        }),
      ).toThrow(/malformed/i);
    }
  });

  test("round-trips bounded raster payloads larger than the ordinary string limit", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Images");
    const bytes = largeValidPngBytes();
    sheet.images.add({
      blob: bytes.buffer,
      contentType: "image/png",
      anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
    });

    const restored = Workbook.fromJSON(workbook.toJSON());
    expect(restored.worksheets.getItem("Images").images.items[0]?.config.dataUrl).toBe(
      sheet.images.items[0]?.config.dataUrl,
    );
  });
});
