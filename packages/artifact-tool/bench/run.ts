import { Presentation } from "../src/presentation";
import { Workbook } from "../src/spreadsheet";
import {
  attachBudgets,
  loadBudgets,
  matrix,
  measure,
  measureBrowserBuildClosure,
  type Measurement,
} from "./support";

const mode: "ci" | "deep" = process.argv.includes("--deep") ? "deep" : "ci";
const assertRelease = process.argv.includes("--assert-release");
const jsonOnly = process.argv.includes("--json");
const budgets = await loadBudgets();
const measurements: Measurement[] = [];

await benchmarkCreation();
await benchmarkBulkWrite();
await benchmarkFormulaRecalculation();
await benchmarkSparseSheet();
await benchmarkSnapshot();
await benchmarkSpreadsheetRendering();
await benchmarkPresentation();
await benchmarkBrowserClosure();

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode,
  runtime: `Bun ${Bun.version}`,
  platform: `${process.platform}-${process.arch}`,
  backend: "typescript-reference",
  budgetsSource: budgets.source,
  measurements,
};

if (jsonOnly) console.log(JSON.stringify(report));
else {
  for (const result of measurements) console.log(JSON.stringify(result));
  console.log(JSON.stringify({ summary: summarize(measurements) }));
}

if (assertRelease) {
  const comparable = measurements.filter((result) => result.releaseComparable === true);
  const failures = comparable.filter((result) => result.releaseBudgetMet === false);
  if (comparable.length === 0) {
    console.error("The TypeScript reference backend cannot certify native/WASM release budgets");
    process.exitCode = 2;
  } else if (failures.length > 0) {
    console.error(
      `Release performance budget failures: ${failures.map(({ name }) => name).join(", ")}`,
    );
    process.exitCode = 1;
  }
}

async function benchmarkCreation(): Promise<void> {
  const samples = mode === "deep" ? 200 : 20;
  record(
    await measure("create_workbook_and_sheet", mode, 1, samples, () => {
      const workbook = Workbook.create();
      workbook.worksheets.add("Sheet1");
    }),
  );
}

async function benchmarkBulkWrite(): Promise<void> {
  const cells =
    mode === "deep" ? budgets.deepFixtures.primitiveCells! : ciUnits("bulk_write_primitive_cells");
  const columns = 100;
  const rows = cells / columns;
  const values = matrix(rows, columns, (index) => index);
  const samples = mode === "deep" ? 12 : 3;
  const heapBefore = process.memoryUsage().heapUsed;
  const result = await measure("bulk_write_primitive_cells", mode, cells, samples, () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Data").getRange("A1").writeValues(values);
  });
  result.heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  record(result);
}

async function benchmarkFormulaRecalculation(): Promise<void> {
  const formulas =
    mode === "deep"
      ? budgets.deepFixtures.dependentFormulas!
      : ciUnits("recalculate_simple_dependents");
  const columns = 100;
  const rows = formulas / columns;
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("Calc");
  sheet.getRange("A1").values = [[1]];
  sheet.getRangeByIndexes(1, 0, rows, columns).formulas = matrix(
    rows,
    columns,
    (index) => `=$A$1+${index}`,
  );
  workbook.recalculate();
  const samples = mode === "deep" ? 12 : 3;
  let input = 2;
  const result = await measure("recalculate_simple_dependents", mode, formulas, samples, () => {
    sheet.getRange("A1").values = [[input++]];
    workbook.recalculate();
  });
  record(result);
}

async function benchmarkSparseSheet(): Promise<void> {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("Sparse");
  const rows = budgets.deepFixtures.sparseSheetRows!;
  const points = mode === "deep" ? 10_000 : 1_000;
  const heapBefore = process.memoryUsage().heapUsed;
  workbook.transact(() => {
    for (let index = 0; index < points; index += 1) {
      const row = Math.floor((index * (rows - 1)) / Math.max(1, points - 1));
      sheet.getCell(row, index % 16).values = [[index]];
    }
  });
  const encoded = JSON.stringify(workbook.toJSON());
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  measurements.push({
    name: "sparse_million_row_sheet",
    mode,
    workUnits: points,
    samples: 1,
    minMs: 0,
    medianMs: 0,
    p95Ms: 0,
    maxMs: 0,
    heapDeltaBytes,
    outputBytes: new TextEncoder().encode(encoded).byteLength,
    facts: {
      logicalRows: rows,
      storedCells: [...sheet.cellEntries()].length,
      usedRowCount: sheet.getUsedRange()?.address.rowCount ?? 0,
    },
  });
}

async function benchmarkSnapshot(): Promise<void> {
  const cells = mode === "deep" ? 100_000 : ciUnits("json_snapshot_round_trip");
  const workbook = Workbook.create();
  workbook.worksheets
    .add("Data")
    .getRange("A1")
    .writeValues(matrix(cells / 100, 100, (index) => index));
  const result = await measure(
    "json_snapshot_round_trip",
    mode,
    cells,
    mode === "deep" ? 10 : 3,
    () => {
      const encoded = JSON.stringify(workbook.toJSON());
      const decoded = Workbook.fromJSON(JSON.parse(encoded));
      if (decoded.worksheets.getActiveWorksheet().formulaCount() !== 0)
        throw new Error("snapshot mismatch");
    },
  );
  result.outputBytes = new TextEncoder().encode(JSON.stringify(workbook.toJSON())).byteLength;
  record(result);
}

async function benchmarkSpreadsheetRendering(): Promise<void> {
  const svgCells = mode === "deep" ? 5_000 : ciUnits("render_spreadsheet_svg");
  const workbook = Workbook.create();
  workbook.worksheets
    .add("Render")
    .getRange("A1")
    .writeValues(matrix(svgCells / 20, 20, (index) => `v${index}`));
  const svgMemory = process.memoryUsage();
  const svgResult = await measure(
    "render_spreadsheet_svg",
    mode,
    svgCells,
    mode === "deep" ? 10 : 3,
    async () => {
      await workbook.render({ format: "svg", range: `A1:T${svgCells / 20}`, scale: 2 });
    },
  );
  svgResult.outputBytes = (
    await workbook.render({ format: "svg", range: `A1:T${svgCells / 20}`, scale: 2 })
  ).size;
  attachProcessMemoryDelta(svgResult, svgMemory);
  record(svgResult);

  const pngCells = mode === "deep" ? 300 : ciUnits("render_spreadsheet_png");
  const pngWorkbook = Workbook.create();
  pngWorkbook.worksheets
    .add("Raster")
    .getRange("A1")
    .writeValues(matrix(pngCells / 10, 10, (index) => index));
  await pngWorkbook.render({ format: "png", range: `A1:J${pngCells / 10}`, scale: 2 });
  const pngMemory = process.memoryUsage();
  const pngResult = await measure(
    "render_spreadsheet_png",
    mode,
    pngCells,
    mode === "deep" ? 10 : 2,
    async () => {
      await pngWorkbook.render({ format: "png", range: `A1:J${pngCells / 10}`, scale: 2 });
    },
  );
  pngResult.outputBytes = (
    await pngWorkbook.render({ format: "png", range: `A1:J${pngCells / 10}`, scale: 2 })
  ).size;
  attachProcessMemoryDelta(pngResult, pngMemory);
  record(pngResult);
}

async function benchmarkPresentation(): Promise<void> {
  const slides =
    mode === "deep" ? budgets.deepFixtures.presentationSlides! : ciUnits("layout_presentation");
  const presentation = Presentation.create();
  for (let index = 0; index < slides; index += 1) {
    presentation.slides.add().shapes.add({
      geometry: "textbox",
      name: `title-${index}`,
      text: `Slide ${index}`,
      position: { left: 72, top: 72, width: 800, height: 100 },
    });
  }
  const layoutMemory = process.memoryUsage();
  const layout = await measure(
    "layout_presentation",
    mode,
    slides,
    mode === "deep" ? 20 : 3,
    () => {
      const snapshot = presentation.layoutSnapshot();
      if ((snapshot.slides as unknown[]).length !== slides) throw new Error("layout mismatch");
    },
  );
  layout.outputBytes = new TextEncoder().encode(
    JSON.stringify(presentation.layoutSnapshot()),
  ).byteLength;
  attachProcessMemoryDelta(layout, layoutMemory);
  record(layout);

  const first = presentation.slides.getItem(0);
  const renderMemory = process.memoryUsage();
  const render = await measure(
    "render_presentation_svg",
    mode,
    1,
    mode === "deep" ? 20 : 3,
    async () => {
      await first.export({ format: "svg", scale: 2 });
    },
  );
  attachProcessMemoryDelta(render, renderMemory);
  record(render);
}

async function benchmarkBrowserClosure(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    external: ["@resvg/resvg-js", "docx", "exceljs", "pptxgenjs", "sharp"],
  });
  if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
  const closure = await measureBrowserBuildClosure(build.outputs);
  measurements.push({
    name: "browser_facade_bundle_closure",
    mode,
    workUnits: 1,
    samples: 1,
    minMs: 0,
    medianMs: 0,
    p95Ms: 0,
    maxMs: 0,
    outputBytes: closure.eager.rawBytes,
    facts: {
      outputCount: closure.eager.outputCount,
      gzipBytes: closure.eager.gzipBytes,
      lazyRawBytes: closure.lazy.rawBytes,
      lazyGzipBytes: closure.lazy.gzipBytes,
      lazyOutputCount: closure.lazy.outputCount,
      installRawBytes: closure.total.rawBytes,
      installGzipBytes: closure.total.gzipBytes,
      installOutputCount: closure.total.outputCount,
    },
  });
}

function ciUnits(name: string): number {
  const budget = budgets.ci.operations[name];
  if (!budget) throw new Error(`Missing CI budget: ${name}`);
  return budget.workUnits;
}

function record(measurement: Measurement): void {
  measurements.push(attachBudgets(measurement, budgets, false));
}

function attachProcessMemoryDelta(
  measurement: Measurement,
  before: ReturnType<typeof process.memoryUsage>,
): void {
  const after = process.memoryUsage();
  measurement.heapDeltaBytes = Math.max(0, after.heapUsed - before.heapUsed);
  measurement.rssDeltaBytes = Math.max(0, after.rss - before.rss);
  measurement.externalMemoryDeltaBytes = Math.max(0, after.external - before.external);
}

function summarize(results: readonly Measurement[]): Record<string, number> {
  return {
    measurements: results.length,
    releasePass: results.filter(({ releaseBudgetMet }) => releaseBudgetMet === true).length,
    releaseFail: results.filter(({ releaseBudgetMet }) => releaseBudgetMet === false).length,
    ciPass: results.filter(({ ciBudgetMet }) => ciBudgetMet === true).length,
    ciFail: results.filter(({ ciBudgetMet }) => ciBudgetMet === false).length,
  };
}
