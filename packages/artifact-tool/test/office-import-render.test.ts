import { describe, expect, test as bunTest } from "bun:test";

import sharp from "sharp";

import {
  Document,
  DocumentFile,
  Presentation,
  PresentationFile,
  SpreadsheetFile,
  Workbook,
  configureArtifactRuntime,
  disposeArtifact,
} from "../src";
import {
  productionTestRuntime,
  productionTestRuntimeAvailable,
} from "./production-runtime-fixture";

const nativeRuntimeAvailable = productionTestRuntimeAvailable();
const test = nativeRuntimeAvailable ? bunTest : bunTest.skip;
if (nativeRuntimeAvailable) configureArtifactRuntime(productionTestRuntime());

describe("Office import raster regression", () => {
  test("renders imported DOCX text into visible pixels", async () => {
    const source = Document.create({ idNamespace: "0011223344556677" });
    source.blocks.addHeading("Modal Product Proof", 1);
    source.blocks.addParagraph("Created through the production artifact skill");
    const imported = await DocumentFile.importDocx(await DocumentFile.exportDocx(source));

    try {
      const png = await imported.render({ format: "png", scale: 2 });
      expect(await darkPixelCount(png)).toBeGreaterThan(500);
    } finally {
      disposeArtifact(source);
      disposeArtifact(imported);
    }
  }, 30_000);

  test("renders imported XLSX values and calculated formulas into visible pixels", async () => {
    const source = Workbook.create();
    const sheet = source.worksheets.add("Summary");
    sheet.getRange("A1:B1").values = [[2, 3]];
    sheet.getRange("C1").formulas = [["=A1+B1"]];
    const imported = await SpreadsheetFile.importXlsx(await SpreadsheetFile.exportXlsx(source));

    try {
      imported.recalculate();
      expect(imported.worksheets.getItem("Summary").getRange("A1:C1").values).toEqual([[2, 3, 5]]);
      const png = await imported.render({
        sheetName: "Summary",
        range: "A1:C1",
        format: "png",
        scale: 2,
      });
      // Grid lines are intentionally lighter than this threshold. These dark
      // pixels therefore prove the three cell glyphs survived rasterization.
      expect(await darkPixelCount(png)).toBeGreaterThan(30);
    } finally {
      disposeArtifact(source);
      disposeArtifact(imported);
    }
  }, 30_000);

  test("renders imported PPTX text in slide and montage rasters", async () => {
    const source = Presentation.create();
    const slide = source.slides.add();
    slide.shapes.add({
      geometry: "textbox",
      name: "Proof title",
      text: "Modal Product Proof",
      position: { left: 40, top: 40, width: 500, height: 100 },
    });
    const imported = await PresentationFile.importPptx(await PresentationFile.exportPptx(source));

    try {
      const importedSlide = imported.slides.items[0];
      expect(importedSlide).toBeDefined();
      const [slidePng, montagePng] = await Promise.all([
        importedSlide!.export({ format: "png", scale: 2 }),
        imported.export({ format: "png", montage: true, scale: 1 }),
      ]);
      expect(await darkPixelCount(slidePng)).toBeGreaterThan(100);
      expect(await darkPixelCount(montagePng)).toBeGreaterThan(100);
    } finally {
      disposeArtifact(source);
      disposeArtifact(imported);
    }
  }, 30_000);
});

async function darkPixelCount(blob: Blob): Promise<number> {
  const pixels = await sharp(new Uint8Array(await blob.arrayBuffer()))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer();
  let count = 0;
  for (const value of pixels) if (value < 160) count += 1;
  return count;
}
