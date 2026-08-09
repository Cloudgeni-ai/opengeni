import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Presentation,
  PresentationFile,
  SpreadsheetFile,
  Workbook,
  configureArtifactRuntime,
} from "../src";
import { productionTestRuntime } from "./production-runtime-fixture";

configureArtifactRuntime(productionTestRuntime());

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function ndjsonRecords(ndjson: string): Array<Record<string, unknown>> {
  return ndjson
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectPng(bytes: Uint8Array): void {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  expect(bytes.byteLength).toBeGreaterThan(100);
}

function expectWebp(bytes: Uint8Array): void {
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
  expect(bytes.byteLength).toBeGreaterThan(100);
}

function expectZip(bytes: Uint8Array): void {
  expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(bytes.byteLength).toBeGreaterThan(1_000);
}

describe("spreadsheet skill public-workflow conformance", () => {
  test("creates, calculates, inspects, traces, renders, and exports a workbook", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opengeni-artifact-workbook-"));

    try {
      const workbook = Workbook.create();
      const sheet = workbook.worksheets.add("Summary");

      sheet.getRange("A1:C4").values = [
        ["Month", "Revenue", "EBITDA"],
        ["Jan", 100, 10],
        ["Feb", 120, 18],
        ["Mar", 130, 22],
      ];
      sheet.getRange("D1").values = [["Margin"]];
      sheet.getRange("D2").formulas = [["=C2/B2"]];
      sheet.getRange("D2:D4").fillDown();

      sheet.getRange("A1:D1").format = {
        fill: "#0F766E",
        font: { bold: true, color: "#FFFFFF" },
      };
      sheet.getRange("B2:C4").format.numberFormat = "$#,##0";
      sheet.getRange("D2:D4").format.numberFormat = "0.0%";

      expect(sheet.getRange("A1:D4").values).toEqual([
        ["Month", "Revenue", "EBITDA", "Margin"],
        ["Jan", 100, 10, 0.1],
        ["Feb", 120, 18, 0.15],
        ["Mar", 130, 22, 22 / 130],
      ]);
      expect(sheet.getRange("D2:D4").formulas).toEqual([["=C2/B2"], ["=C3/B3"], ["=C4/B4"]]);

      const table = await workbook.inspect({
        kind: "table",
        range: "Summary!A1:D4",
        include: "values,formulas",
        tableMaxRows: 10,
        tableMaxCols: 10,
      });
      expect(table.ndjson).toContain("Revenue");
      expect(table.ndjson).toContain("=C2/B2");

      const formula = await workbook.inspect({
        kind: "formula",
        sheetId: "Summary",
        range: "D2:D4",
        maxChars: 2_000,
      });
      expect(ndjsonRecords(formula.ndjson)).toHaveLength(3);
      expect(formula.ndjson).toContain("=C4/B4");

      const help = workbook.help("worksheet.getRange", {
        include: "index,examples",
        maxChars: 2_000,
      });
      expect(ndjsonRecords(help.ndjson).length).toBeGreaterThan(0);
      expect(help.ndjson.toLowerCase()).toContain("getrange");

      const trace = workbook.trace("Summary!D4");
      const traceText = JSON.stringify(trace);
      expect(traceText).toContain("Summary");
      expect(traceText).toContain("=C4/B4");
      expect(traceText).toContain(String(22 / 130));

      const preview = await workbook.render({
        sheetName: "Summary",
        range: "A1:D4",
        autoCrop: "all",
        scale: 1,
        format: "png",
      });
      expectPng(await bytesOf(preview));

      const xlsx = await SpreadsheetFile.exportXlsx(workbook);
      const xlsxBytes = await bytesOf(xlsx);
      expectZip(xlsxBytes);
      const outputPath = join(outputDir, "summary.xlsx");
      await xlsx.save(outputPath);
      expect(Uint8Array.from(await readFile(outputPath))).toEqual(Uint8Array.from(xlsxBytes));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("presentation skill public-workflow conformance", () => {
  test("creates editable objects, inspects them, renders, and exports a deck", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "opengeni-artifact-deck-"));

    try {
      const presentation = Presentation.create({
        slideSize: { width: 1280, height: 720 },
      });
      const slide = presentation.slides.add();
      slide.background.fill = "slate-50";

      const title = slide.shapes.add({
        geometry: "textbox",
        name: "hero-title",
        position: { left: 72, top: 64, width: 520, height: 184 },
        fill: "none",
        line: { style: "solid", fill: "none", width: 0 },
      });
      title.text = "Editable artifact engine";
      title.text.style = { fontSize: 42, bold: true, color: "slate-950" };

      const chart = slide.charts.add("bar", {
        name: "coverage-chart",
        position: { left: 650, top: 110, width: 500, height: 360 },
        categories: ["Rows", "Grid", "Tokens"],
        series: [{ name: "Coverage", values: [3, 4, 5], fill: "accent1" }],
        hasLegend: false,
        dataLabels: { showValue: true, position: "outEnd" },
      });

      expect(presentation.slides.items).toHaveLength(1);

      const inspection = await presentation.inspect({
        kind: "slide,textbox,shape,chart",
        maxChars: 8_000,
      });
      expect(inspection.ndjson).toContain("Editable artifact engine");
      expect(inspection.ndjson).toContain("coverage-chart");
      const records = ndjsonRecords(inspection.ndjson);
      const titleRecord = records.find((record) =>
        JSON.stringify(record).includes("Editable artifact engine"),
      );
      const chartRecord = records.find((record) =>
        JSON.stringify(record).includes("coverage-chart"),
      );
      expect(typeof titleRecord?.id).toBe("string");
      expect(typeof chartRecord?.id).toBe("string");
      expect(presentation.resolve(titleRecord!.id as string)).toBe(title);
      expect(presentation.resolve(chartRecord!.id as string)).toBe(chart);

      const png = await presentation.export({ slide, format: "png", scale: 1 });
      expectPng(await bytesOf(png));

      const layout = await slide.export({ format: "layout" });
      const layoutText = await layout.text();
      expect(() => JSON.parse(layoutText)).not.toThrow();
      expect(layoutText).toContain("hero-title");
      expect(layoutText).toContain("coverage-chart");

      const montage = await presentation.export({
        format: "webp",
        montage: true,
        scale: 1,
      });
      expectWebp(await bytesOf(montage));

      const pptx = await PresentationFile.exportPptx(presentation);
      const pptxBytes = await bytesOf(pptx);
      expectZip(pptxBytes);
      const outputPath = join(outputDir, "deck.pptx");
      await pptx.save(outputPath);
      expect(Uint8Array.from(await readFile(outputPath))).toEqual(Uint8Array.from(pptxBytes));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 30_000);
});
