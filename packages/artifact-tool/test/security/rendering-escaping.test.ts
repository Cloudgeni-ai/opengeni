import { describe, expect, test } from "bun:test";

import { Document, DocumentTextRun } from "../../src/document";
import { Presentation } from "../../src/presentation";
import { Workbook } from "../../src/spreadsheet";
import { SpreadsheetFile } from "../../src/spreadsheet-file";

const ATTACK = '<script>alert("artifact")</script><image href="file:///etc/passwd">&';

describe("rendered markup security", () => {
  test("escapes document text in HTML and SVG", async () => {
    const document = Document.create();
    document.blocks.addParagraph(ATTACK);
    document.blocks.addTable([[ATTACK]]);

    const html = await (await document.render({ format: "html" })).text();
    const svg = await (await document.render({ format: "svg" })).text();

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<image href="file:///etc/passwd">');
    expect(html).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('<image href="file:///etc/passwd">');
    expect(svg).toContain("&lt;script&gt;");
  });

  test("escapes spreadsheet cell text, font names, and image alt text in SVG", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Markup");
    sheet.getRange("A1").values = [[ATTACK]];
    sheet.getRange("A1").format = {
      font: { name: 'Arial" onload="alert(1)', color: '#000000" onload="alert(2)' },
    };
    sheet.images.add({
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      contentType: "image/png",
      alt: ATTACK,
      anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 1, heightPx: 1 } },
    });

    const svg = await (await workbook.render({ sheetName: "Markup", format: "svg" })).text();
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('onload="alert');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot; onload=&quot;");
  });

  test("escapes presentation text, chart titles, font names, and prompts in SVG", async () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();
    slide.shapes.add({
      geometry: "textbox",
      text: ATTACK,
      textStyle: { fontFamily: 'Arial" onload="alert(1)' },
    });
    slide.charts.add("bar", {
      title: ATTACK,
      series: [{ name: "Series", values: [1] }],
    });
    slide.images.add({ prompt: ATTACK });

    const svg = await (await slide.export({ format: "svg" })).text();
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('onload="alert');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot; onload=&quot;");
  });

  test("SEC-004 rejects style values that can break document HTML or SVG attributes", async () => {
    const document = Document.create();
    expect(() =>
      document.blocks.addParagraph([
        new DocumentTextRun("safe", { fontFamily: 'Arial"><script>alert(1)</script>' }),
      ]),
    ).toThrow(/style|font|unsafe/i);
    document.blocks.addParagraph("safe");
    await expect(
      document.render({ format: "svg", background: '"><script>alert(2)</script>' }),
    ).rejects.toThrow(/background|color|unsafe/i);
  });

  test("SEC-005 rejects active/external image sources in presentation and spreadsheet models", async () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();
    expect(() => slide.images.add({ uri: "file:///etc/passwd" })).toThrow(/external|uri|scheme/i);
    expect(() =>
      slide.images.add({
        dataUrl: "data:image/svg+xml,<svg onload='alert(1)'/>",
      }),
    ).toThrow(/active|mime|svg|base64|raster|dataurl/i);

    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Unsafe");
    expect(() =>
      sheet.images.add({
        dataUrl: "data:image/svg+xml,<svg onload='alert(1)'/>",
        anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
      }),
    ).toThrow(/active|image|data/i);
    await expect(SpreadsheetFile.exportXlsx(workbook)).resolves.toBeInstanceOf(Blob);
  });

  test("never invokes a host image resolver implicitly during render or export", async () => {
    let resolverCalls = 0;
    const presentation = Presentation.create({
      allowedImageUriSchemes: ["asset"],
      imageResolver: async () => {
        resolverCalls += 1;
        return { blob: pngBytes(), contentType: "image/png" };
      },
    });
    const slide = presentation.slides.add();
    const image = slide.images.add({ uri: "asset://workspace/owned-image" });

    await expect(slide.export({ format: "svg" })).rejects.toThrow(/unresolved|image|uri/i);
    expect(resolverCalls).toBe(0);

    await image.resolveUri();
    expect(resolverCalls).toBe(1);
    const svg = await (await slide.export({ format: "svg" })).text();
    expect(svg).toContain("data:image/png;base64,");
    expect(resolverCalls).toBe(1);
  });

  test("SEC-011 rejects decoded raster and render allocations beyond pixel budgets", async () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();
    expect(() =>
      slide.images.add({
        dataUrl: declaredPngDataUrl(100_000, 100_000),
      }),
    ).toThrow(/dimension|pixel|limit/i);

    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Oversized image");
    expect(() =>
      sheet.images.add({
        dataUrl: declaredPngDataUrl(100_000, 100_000),
        anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 10, heightPx: 10 } },
      }),
    ).toThrow(/dimension|pixel|limit/i);

    const oversizedSlide = Presentation.create({
      slideSize: { width: 100_000, height: 100_000 },
    }).slides.add();
    await expect(oversizedSlide.export({ format: "png" })).rejects.toThrow(
      /dimension|pixel|limit/i,
    );

    const document = Document.create({
      page: {
        widthPt: 14_400,
        heightPt: 14_400,
        marginTopPt: 72,
        marginRightPt: 72,
        marginBottomPt: 72,
        marginLeftPt: 72,
      },
    });
    await expect(document.render({ format: "png" })).rejects.toThrow(/dimension|pixel|limit/i);
  });
});

function pngBytes(): Uint8Array {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function declaredPngDataUrl(width: number, height: number): string {
  const bytes = pngBytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}
