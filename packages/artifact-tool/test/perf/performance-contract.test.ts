import { describe, expect, test } from "bun:test";

import { Presentation } from "../../src/presentation";
import { Workbook } from "../../src/spreadsheet";
import {
  loadBudgets,
  matrix,
  type BrowserBuildClosure,
  type PerfBudgets,
} from "../../bench/support";

const budgets = await loadBudgets();
const platformEvidence = (await Bun.file(
  new URL("../../bench/platform-evidence.json", import.meta.url),
).json()) as {
  schemaVersion: number;
  targets: Array<{
    target: string;
    kernelCore: string;
    packagedRuntime: string;
    sandboxRuntime: string;
  }>;
};

describe("artifact CI performance contract", () => {
  test("machine-readable budgets remain linked to the architecture contract", () => {
    expect(budgets.schemaVersion).toBe(1);
    expect(budgets.source).toBe("docs/artifact-engine.md#11-performance-budgets");
    expect(budgets.release.operations.bulk_write_primitive_cells).toEqual({
      p95Ms: 100,
      workUnits: 100_000,
    });
    expect(budgets.release.operations.recalculate_simple_dependents).toEqual({
      p95Ms: 50,
      workUnits: 100_000,
    });
    expect(budgets.release.operations.dense_tile_random_edit).toEqual({
      p95Ms: 1,
      workUnits: 10_000,
    });
    expect(budgets.release.operations.collaboration_random_edit_on_million_cells).toEqual({
      p95Ms: 5,
      workUnits: 200,
    });
    expect(budgets.release.operations.binding_stateful_edit).toEqual({
      p95Ms: 0.1,
      workUnits: 20_000,
    });
    expect(budgets.ci.structural.bindingStatefulMinimumSpeedupRatio).toBe(100);
    expect(budgets.ci.structural.rustCollaborationMillionModelPeakLiveDeltaMaxBytes).toBe(
      1_073_741_824,
    );
    expect(budgets.ci.structural.wasmMillionCellHeapMaxBytes).toBe(134_217_728);
    expect(platformEvidence.schemaVersion).toBe(1);
    expect(platformEvidence.targets.map(({ target }) => target)).toEqual([
      "darwin-x64",
      "darwin-arm64",
      "linux-x64-gnu",
      "linux-arm64-gnu",
      "linux-x64-musl",
      "linux-arm64-musl",
      "win32-x64-msvc",
      "wasm-web",
    ]);
    expect(
      platformEvidence.targets.filter(({ kernelCore }) => kernelCore.startsWith("measured")),
    ).toHaveLength(2);
    expect(
      platformEvidence.targets.every(({ packagedRuntime }) => packagedRuntime === "unmeasured"),
    ).toBe(true);
  });

  test("creates and bulk-writes within shared-runner guardrails", () => {
    assertTimed("create_workbook_and_sheet", () => {
      const workbook = Workbook.create();
      workbook.worksheets.add("Sheet1");
    });

    const count = units("bulk_write_primitive_cells");
    const values = matrix(count / 100, 100, (index) => index);
    assertTimed("bulk_write_primitive_cells", () => {
      const workbook = Workbook.create();
      workbook.worksheets.add("Data").getRange("A1").writeValues(values);
    });
  }, 15_000);

  test("recalculates a bounded dependency fixture within guardrail", () => {
    const count = units("recalculate_simple_dependents");
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Calc");
    sheet.getRange("A1").values = [[1]];
    sheet.getRangeByIndexes(1, 0, count / 100, 100).formulas = matrix(
      count / 100,
      100,
      (index) => `=$A$1+${index}`,
    );
    workbook.recalculate();
    assertTimed("recalculate_simple_dependents", () => {
      sheet.getRange("A1").values = [[2]];
      workbook.recalculate();
    });
  }, 15_000);

  test("snapshot round-trip and sparse million-row representation stay bounded", () => {
    const count = units("json_snapshot_round_trip");
    const workbook = Workbook.create();
    workbook.worksheets
      .add("Data")
      .getRange("A1")
      .writeValues(matrix(count / 100, 100, (index) => index));
    assertTimed("json_snapshot_round_trip", () => {
      const encoded = JSON.stringify(workbook.toJSON());
      const restored = Workbook.fromJSON(JSON.parse(encoded));
      expect([...restored.worksheets.getActiveWorksheet().cellEntries()]).toHaveLength(count);
    });

    const sparse = Workbook.create();
    const sheet = sparse.worksheets.add("Sparse");
    const heapBefore = process.memoryUsage().heapUsed;
    sparse.transact(() => {
      for (let index = 0; index < 1_000; index += 1) {
        sheet.getCell(index * 1_000, index % 16).values = [[index]];
      }
    });
    const serializedBytes = new TextEncoder().encode(JSON.stringify(sparse.toJSON())).byteLength;
    const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    expect(serializedBytes).toBeLessThan(
      budgets.ci.structural.sparse_million_row_serializedMaxBytes!,
    );
    expect([...sheet.cellEntries()]).toHaveLength(1_000);
    expect(sheet.getUsedRange()?.address.rowCount).toBe(999_001);
    expect(heapDelta).toBeLessThan(budgets.ci.structural.sparse_million_row_heapDeltaMaxBytes!);
  }, 15_000);

  test("SVG and warm PNG rendering remain bounded", async () => {
    const svgCount = units("render_spreadsheet_svg");
    const workbook = Workbook.create();
    workbook.worksheets
      .add("Render")
      .getRange("A1")
      .writeValues(matrix(svgCount / 20, 20, (index) => index));
    await assertTimedAsync("render_spreadsheet_svg", async () => {
      const output = await workbook.render({
        format: "svg",
        range: `A1:T${svgCount / 20}`,
        scale: 2,
      });
      expect(output.type).toBe("image/svg+xml");
    });

    const pngCount = units("render_spreadsheet_png");
    const raster = Workbook.create();
    raster.worksheets
      .add("Raster")
      .getRange("A1")
      .writeValues(matrix(pngCount / 10, 10, (index) => index));
    await raster.render({ format: "png", range: `A1:J${pngCount / 10}`, scale: 2 });
    await assertTimedAsync("render_spreadsheet_png", async () => {
      const output = await raster.render({
        format: "png",
        range: `A1:J${pngCount / 10}`,
        scale: 2,
      });
      expect(output.type).toBe("image/png");
    });
  }, 20_000);

  test("merged-cell rendering stays linear in visible cells", async () => {
    const mergeCount = units("render_spreadsheet_merged_cells");
    const rows = 250;
    const columns = 160;
    expect(mergeCount * 2).toBe(rows * columns);
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Merges");
    const rawMerges = Array.from({ length: mergeCount }, (_value, index) => ({
      row: Math.floor(index / (columns / 2)),
      col: (index % (columns / 2)) * 2,
      rowCount: 1,
      colCount: 2,
    }));
    const entries = rawMerges.map(({ row, col }) => ({
      row,
      col,
      data: { value: null, formula: null, format: {} },
    }));
    let mergePropertyReads = 0;
    const merges = rawMerges.map(
      (merge) =>
        new Proxy(merge, {
          get(target, property, receiver) {
            if (
              property === "row" ||
              property === "col" ||
              property === "rowCount" ||
              property === "colCount"
            ) {
              mergePropertyReads += 1;
            }
            return Reflect.get(target, property, receiver);
          },
        }),
    );
    Object.defineProperties(sheet, {
      mergeRegions: { configurable: true, value: () => merges },
      cellEntries: {
        configurable: true,
        value: function* () {
          yield* entries;
        },
      },
    });
    Object.defineProperty(workbook, "valueAt", {
      configurable: true,
      value: () => null,
    });

    await assertTimedAsync("render_spreadsheet_merged_cells", async () => {
      const output = await workbook.render({ format: "svg", range: "A1:FD250" });
      expect(output.type).toBe("image/svg+xml");
    });
    expect(mergePropertyReads).toBeLessThan(mergeCount * 80);
  }, 15_000);

  test("dense numeric SVG rendering reuses bounded formatters", async () => {
    const cellCount = units("render_spreadsheet_numeric_svg");
    const rows = 680;
    const columns = 147;
    expect(rows * columns).toBe(cellCount);
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Numeric");
    sheet.getRangeByIndexes(0, 0, rows, columns).values = matrix(rows, columns, (index) => index);
    // Accepted custom formats may be long; Intl's own fraction-digit range
    // must never turn model content into a renderer exception.
    sheet.getRange("A1").format.numberFormat = `0.${"0".repeat(1_000)}`;

    await assertTimedAsync("render_spreadsheet_numeric_svg", async () => {
      const output = await workbook.render({ format: "svg", range: "A1:EQ680" });
      expect(output.type).toBe("image/svg+xml");
    });
  }, 15_000);

  test("500-slide layout and one-slide SVG rendering remain bounded", async () => {
    const slideCount = units("layout_presentation");
    const presentation = Presentation.create();
    for (let index = 0; index < slideCount; index += 1) {
      presentation.slides.add().shapes.add({
        geometry: "textbox",
        text: `Slide ${index}`,
        position: { left: 72, top: 72, width: 800, height: 100 },
      });
    }
    assertTimed("layout_presentation", () => {
      const layout = presentation.layoutSnapshot();
      expect((layout.slides as unknown[]).length).toBe(slideCount);
    });
    await assertTimedAsync("render_presentation_svg", async () => {
      const output = await presentation.slides.getItem(0).export({ format: "svg", scale: 2 });
      expect(output.type).toBe("image/svg+xml");
    });
  }, 15_000);

  test("browser facade closure stays small with optional codecs externalized", async () => {
    const closure = await measureBrowserFacadeClosure();
    expect(closure.eager.rawBytes).toBeLessThan(budgets.ci.structural.browserFacadeBundleMaxBytes!);
    expect(closure.eager.gzipBytes).toBeLessThan(budgets.ci.structural.browserFacadeGzipMaxBytes!);
    expect(closure.eager.outputCount).toBeLessThanOrEqual(
      budgets.ci.structural.browserFacadeOutputMaxCount!,
    );
    expect(closure.total.rawBytes).toBeLessThan(
      budgets.ci.structural.browserInstallClosureMaxBytes!,
    );
    expect(closure.total.gzipBytes).toBeLessThan(
      budgets.ci.structural.browserInstallClosureGzipMaxBytes!,
    );
    expect(closure.total.outputCount).toBeLessThanOrEqual(
      budgets.ci.structural.browserInstallClosureOutputMaxCount!,
    );

    // If a codec or native rasterizer ever becomes a static dependency of the
    // root facade, its external package import becomes reachable in the eager
    // graph and this fails even when the byte ceiling still has headroom.
    const optionalRuntimeImports = ["@resvg/resvg-js", "docx", "exceljs", "pptxgenjs", "sharp"];
    expect(
      closure.eagerExternalImports.filter((path) => optionalRuntimeImports.includes(path)),
    ).toEqual([]);
    // @resvg/resvg-js and sharp stay intentionally opaque behind native-only
    // runtime loaders; the publish closure guard audits those package edges.
    expect(
      closure.lazyExternalImports.filter((path) => optionalRuntimeImports.includes(path)).sort(),
    ).toEqual(["docx", "exceljs", "pptxgenjs"]);
  }, 20_000);

  test("session and realtime React subpaths contain no artifact engine or codec closure", async () => {
    const forbidden = new Set<string>();
    const bareImportPlugin = {
      name: "artifact-closure-audit",
      setup(build: import("bun").PluginBuilder): void {
        build.onResolve({ filter: /.*/ }, (args) => {
          const artifactLocalPath = /(?:^|\/)artifacts?(?:\/|\.|$)/.test(args.path);
          const artifactPackage = args.path.startsWith("@opengeni/artifact-tool");
          const codecPackage = [
            "docx",
            "exceljs",
            "pptxgenjs",
            "sharp",
            "@resvg/resvg-js",
          ].includes(args.path);
          if (artifactLocalPath || artifactPackage || codecPackage) forbidden.add(args.path);
          if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
            return { path: args.path, external: true };
          }
          return undefined;
        });
      },
    };
    for (const entrypoint of ["../../../react/src/session.ts", "../../../react/src/realtime.ts"]) {
      const result = await Bun.build({
        entrypoints: [new URL(entrypoint, import.meta.url).pathname],
        target: "browser",
        format: "esm",
        splitting: true,
        minify: true,
        plugins: [bareImportPlugin],
      });
      expect(result.success).toBe(true);
    }
    expect(forbidden.size).toBe(budgets.ci.structural.nonArtifactEntrypointArtifactImportMaxCount!);
  }, 20_000);
});

async function measureBrowserFacadeClosure(): Promise<BrowserBuildClosure> {
  // Nested Bun.build package resolution is not isolated from Bun's test module
  // graph. A fresh Bun process makes this release-size gate deterministic while
  // still bundling every real eager dependency.
  const child = Bun.spawn(
    [process.execPath, new URL("../../bench/browser-facade-closure.ts", import.meta.url).pathname],
    {
      cwd: new URL("../../../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`browser closure build failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as BrowserBuildClosure;
}

function units(name: string): number {
  const value = budgets.ci.operations[name];
  if (!value) throw new Error(`Missing CI budget: ${name}`);
  return value.workUnits;
}

function assertTimed(name: string, operation: () => void): void {
  const started = Bun.nanoseconds();
  operation();
  const elapsedMs = Number(Bun.nanoseconds() - started) / 1_000_000;
  expect(elapsedMs).toBeLessThan(limit(budgets, name));
}

async function assertTimedAsync(name: string, operation: () => Promise<void>): Promise<void> {
  const started = Bun.nanoseconds();
  await operation();
  const elapsedMs = Number(Bun.nanoseconds() - started) / 1_000_000;
  expect(elapsedMs).toBeLessThan(limit(budgets, name));
}

function limit(source: PerfBudgets, name: string): number {
  const value = source.ci.operations[name];
  if (!value) throw new Error(`Missing CI budget: ${name}`);
  return value.maxMs;
}
