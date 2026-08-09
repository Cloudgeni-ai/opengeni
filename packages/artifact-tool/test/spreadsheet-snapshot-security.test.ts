import { describe, expect, test } from "bun:test";

import {
  SPREADSHEET_SNAPSHOT_LIMITS,
  Workbook,
  validateSerializedWorkbook,
  type SerializedWorkbook,
} from "../src/spreadsheet";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function oversizedPngDataUrl(): string {
  const [prefix, encoded] = ONE_PIXEL_PNG.split(",") as [string, string];
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, 100_000);
  view.setUint32(20, 100_000);
  return `${prefix},${btoa(String.fromCharCode(...bytes))}`;
}

describe("spreadsheet snapshot security boundary", () => {
  test("round-trips every persisted worksheet object without caller-owned aliases", () => {
    const workbook = Workbook.create();
    workbook.comments.setSelf({ displayName: "Reviewer" });
    const sheet = workbook.worksheets.add("Summary");
    sheet.getRange("A1:C3").values = [
      ["Month", "Revenue", "Double"],
      ["Jan", 120, null],
      ["Feb", 140, null],
    ];
    sheet.getRange("C2:C3").formulas = [["=B2*2"], ["=B3*2"]];
    sheet.getRange("D1").values = [[new Date("2026-08-08T12:34:56.000Z")]];
    sheet.getRange("A1:C1").format = {
      fill: "#0f766e",
      font: { name: "Arial", size: 14, bold: true, color: "#ffffff" },
      borders: { preset: "all", style: "thin", color: "#134e4a" },
    };
    sheet.freezePanes.freezeRows(1);
    sheet.setColumnWidth(0, 140);
    sheet.setRowHeight(0, 32);
    sheet.tables.add("A1:C3", true, "RevenueTable");
    sheet.getRange("A2:A3").dataValidation = {
      rule: { type: "list", values: ["Jan", "Feb", "Mar"] },
    };
    sheet.getRange("B2:B3").conditionalFormats.add("cellIs", {
      operator: "greaterThan",
      formula: 100,
      format: { font: { bold: true }, fill: "#dcfce7" },
    });
    sheet.mergeCells("A5:B5");
    const chart = sheet.charts.add("bar", sheet.getRange("A1:B3"));
    chart.title = "Revenue";
    chart.setPosition("E1", "J12");
    chart.series.add("", { values: [1], categories: ["Other"] });
    sheet.images.add({
      dataUrl: ONE_PIXEL_PNG,
      contentType: "image/png",
      alt: "Status",
      anchor: {
        from: { row: 5, col: 0 },
        extent: { widthPx: 16, heightPx: 16 },
      },
    });
    workbook.comments.addThread({ cell: sheet.getRange("B2") }, "Confirm source");

    const snapshot = workbook.toJSON();
    validateSerializedWorkbook(snapshot);
    const restored = Workbook.fromJSON(snapshot);
    expect(restored.toJSON()).toEqual(snapshot);
    const wireRestored = Workbook.fromJSON(
      JSON.parse(JSON.stringify(snapshot)) as SerializedWorkbook,
    );
    expect(wireRestored.worksheets.getItem("Summary").cellData(0, 3).value).toEqual(
      new Date("2026-08-08T12:34:56.000Z"),
    );

    const sourceCell = snapshot.worksheets[0]!.cells[0]!;
    sourceCell.format.fill = "#ff0000";
    sourceCell.value = "mutated";
    snapshot.worksheets[0]!.images[0]!.anchor.extent.widthPx = 999;
    (snapshot.worksheets[0]!.dataValidations[0]!.config.rule.values as string[])[0] = "mutated";
    (snapshot.worksheets[0]!.conditionalFormattings[0]!.config.format as { fill: string }).fill =
      "#000000";
    expect(restored.worksheets.getItem("Summary").cellData(0, 0)).toMatchObject({
      value: "Month",
      format: { fill: "#0f766e" },
    });
    expect(
      restored.worksheets.getItem("Summary").images.items[0]!.config.anchor.extent.widthPx,
    ).toBe(16);
    expect(restored.worksheets.getItem("Summary").getRange("A2:A3").dataValidation).toEqual({
      rule: { type: "list", values: ["Jan", "Feb", "Mar"] },
    });
    expect(restored.worksheets.getItem("Summary").conditionalFormattings.all()[0]?.config).toEqual({
      format: { fill: "#dcfce7", font: { bold: true } },
      formula: 100,
      operator: "greaterThan",
    });

    const detached = restored.toJSON();
    detached.worksheets[0]!.cells[0]!.format.fill = "#000000";
    expect(restored.worksheets.getItem("Summary").cellData(0, 0).format.fill).toBe("#0f766e");
  });

  test("rejects overlapping merges while allowing edge-adjacent rectangles", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Merges");
    sheet.mergeCells("A1:B2");
    sheet.mergeCells("C1:D2");
    const snapshot = workbook.toJSON();
    expect(() => Workbook.fromJSON(snapshot)).not.toThrow();

    snapshot.worksheets[0]!.merges.push({
      row: 1,
      col: 1,
      rowCount: 2,
      colCount: 2,
    });
    expect(() => Workbook.fromJSON(snapshot)).toThrow(/overlapping merge/i);
  });

  test("rejects hostile object shapes, sparse arrays, and UTF-8 byte overflows", () => {
    const workbook = Workbook.create();
    workbook.worksheets.add("Safe").getRange("A1").values = [["safe"]];

    const accessorSnapshot = workbook.toJSON();
    let getterReads = 0;
    Object.defineProperty(accessorSnapshot.worksheets[0]!, "name", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return "Unsafe";
      },
    });
    expect(() => Workbook.fromJSON(accessorSnapshot)).toThrow(/plain data property/i);
    expect(getterReads).toBe(0);

    const dateSnapshot = workbook.toJSON();
    const hostileDate = new Date();
    let dateGetterReads = 0;
    Object.defineProperty(hostileDate, "getTime", {
      get() {
        dateGetterReads += 1;
        throw new Error("must not execute");
      },
    });
    dateSnapshot.worksheets[0]!.cells[0]!.value = hostileDate as never;
    expect(() => Workbook.fromJSON(dateSnapshot)).toThrow(/plain object|cell value/i);
    expect(dateGetterReads).toBe(0);

    const sparseSnapshot = workbook.toJSON();
    sparseSnapshot.worksheets[0]!.cells = new Array(1);
    expect(() => Workbook.fromJSON(sparseSnapshot)).toThrow(/dense plain array/i);

    const oversized = workbook.toJSON() as SerializedWorkbook & Record<string, unknown>;
    oversized.worksheets = new Array(SPREADSHEET_SNAPSHOT_LIMITS.sheets + 1);
    expect(() => Workbook.fromJSON(oversized)).toThrow(/limit|maximum/i);

    const unicodeSnapshot = workbook.toJSON();
    unicodeSnapshot.worksheets[0]!.cells[0]!.value = "💣".repeat(
      Math.floor(SPREADSHEET_SNAPSHOT_LIMITS.stringBytesEach / 4) + 1,
    );
    expect(() => Workbook.fromJSON(unicodeSnapshot)).toThrow(/UTF-8 bytes/i);

    const longIdSnapshot = workbook.toJSON();
    longIdSnapshot.worksheets[0]!.id = `ws/${"/".repeat(10_000)}1`;
    const restored = Workbook.fromJSON(longIdSnapshot);
    const added = restored.worksheets.add("Next");
    expect(added.id).not.toBe(longIdSnapshot.worksheets[0]!.id);
  });

  test("persists bounded validation and conditional-format configs without aliases", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Rules");
    const values = ["Open", "Closed"];
    sheet.getRange("A1:A10").dataValidation = { rule: { type: "list", values } };
    values[0] = "mutated";
    expect(sheet.getRange("A1:A10").dataValidation).toEqual({
      rule: { type: "list", values: ["Open", "Closed"] },
    });
    const detached = sheet.getRange("A1:A10").dataValidation!;
    (detached.rule.values as string[])[0] = "detached mutation";
    expect(sheet.getRange("A1:A10").dataValidation).toEqual({
      rule: { type: "list", values: ["Open", "Closed"] },
    });

    sheet.getRange("B1:B10").conditionalFormats.add("containsText", {
      text: "late",
      format: { fill: "#fee2e2" },
    });
    const snapshot = workbook.toJSON();
    const restored = Workbook.fromJSON(snapshot);
    expect(restored.toJSON()).toEqual(snapshot);

    const legacy = workbook.toJSON();
    delete (legacy.worksheets[0] as Partial<(typeof legacy.worksheets)[number]>).dataValidations;
    delete (legacy.worksheets[0] as Partial<(typeof legacy.worksheets)[number]>)
      .conditionalFormattings;
    expect(() => Workbook.fromJSON(legacy)).not.toThrow();

    let reads = 0;
    const hostileRule = {};
    Object.defineProperty(hostileRule, "type", {
      enumerable: true,
      get() {
        reads += 1;
        return "list";
      },
    });
    expect(() => {
      sheet.getRange("C1").dataValidation = { rule: hostileRule };
    }).toThrow(/plain data/i);
    expect(reads).toBe(0);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => sheet.getRange("C1").conditionalFormats.add("expression", deep)).toThrow(
      /depth|limit/i,
    );
  });

  test("fails late references and malformed raster bytes before constructing state", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Safe");
    workbook.comments.addThread({ cell: sheet.getRange("A1") }, "Safe");
    const lateInvalid = workbook.toJSON();
    lateInvalid.comments[0]!.sheetId = "ws/missing";

    const malformedImage = workbook.toJSON();
    malformedImage.worksheets[0]!.images.push({
      dataUrl: "data:image/png;base64,AAAA",
      contentType: "image/png",
      anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 1, heightPx: 1 } },
    });
    const oversizedImage = workbook.toJSON();
    oversizedImage.worksheets[0]!.images.push({
      dataUrl: oversizedPngDataUrl(),
      contentType: "image/png",
      anchor: { from: { row: 0, col: 0 }, extent: { widthPx: 1, heightPx: 1 } },
    });
    const invalidIdNamespace = workbook.toJSON();
    invalidIdNamespace.comments[0]!.id = "im/2";

    const descriptor = Object.getOwnPropertyDescriptor(Workbook, "create")!;
    const originalCreate = Workbook.create;
    let creates = 0;
    Object.defineProperty(Workbook, "create", {
      ...descriptor,
      value: (...args: Parameters<typeof Workbook.create>) => {
        creates += 1;
        return originalCreate(...args);
      },
    });
    try {
      expect(() => Workbook.fromJSON(lateInvalid)).toThrow(/references no worksheet/i);
      expect(() => Workbook.fromJSON(malformedImage)).toThrow(/image|raster|signature/i);
      expect(() => Workbook.fromJSON(oversizedImage)).toThrow(/dimension|pixel|limit/i);
      expect(() => Workbook.fromJSON(invalidIdNamespace)).toThrow(/object-id namespace/i);
      expect(creates).toBe(0);
    } finally {
      Object.defineProperty(Workbook, "create", descriptor);
    }
  });

  test("bounds live freeze panes and dimension overrides at XLSX limits", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Dimensions");
    const reasons: string[] = [];
    workbook.onChange((change) => reasons.push(change.reason));

    expect(() => sheet.setColumnWidth(0.5, 10)).toThrow(/integer/i);
    expect(() => sheet.setRowHeight(0.5, 10)).toThrow(/integer/i);
    expect(() => sheet.setColumnWidth(0, 0.5)).toThrow(/at least/i);
    expect(() => sheet.setRowHeight(0, 0.5)).toThrow(/at least/i);
    expect(() => sheet.freezePanes.freezeRows(1_048_577)).toThrow(/integer/i);
    expect(() => sheet.freezePanes.freezeColumns(16_385)).toThrow(/integer/i);
    expect(() => sheet.freezePanes.freezeRows(1.5)).toThrow(/integer/i);

    sheet.setColumnWidth(0, 100);
    sheet.setRowHeight(0, 30);
    expect(reasons).toEqual(["dimension", "dimension"]);
  });

  test("canonicalizes blob images without producing an invalid output snapshot", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Images");
    expect(() => sheet.tables.add("A1", true, "")).toThrow(/name.*empty/i);

    const snapshot = workbook.toJSON();
    const payload = ONE_PIXEL_PNG.slice(ONE_PIXEL_PNG.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    snapshot.worksheets[0]!.images.push({
      blob: bytes.buffer,
      contentType: "image/png",
      anchor: {
        from: { row: 0, col: 0 },
        extent: { widthPx: 1, heightPx: 1 },
      },
    });

    const restored = Workbook.fromJSON(snapshot);
    const canonical = restored.toJSON();
    expect(() => validateSerializedWorkbook(canonical)).not.toThrow();
    expect(canonical.worksheets[0]!.images[0]).toMatchObject({
      dataUrl: ONE_PIXEL_PNG,
      contentType: "image/png",
    });
    expect(canonical.worksheets[0]!.images[0]!.blob).toBeUndefined();
  });

  test("keeps ordinary live mutations inside the restorable model", async () => {
    const workbook = Workbook.create();
    const first = workbook.worksheets.add("First");
    workbook.worksheets.add("Second");
    await expect(first.fromCSV("value", { sheetName: "Second" })).rejects.toThrow(
      /already exists/i,
    );
    expect(first.name).toBe("First");

    first.getRange("A1:B2").values = [
      ["Category", "Value"],
      ["Other", "not numeric"],
    ];
    first.charts.add("bar", first.getRange("A1:B2"));
    expect(first.charts.items[0]!.series.items[0]!.values).toEqual([0]);
    const manualValues = [1];
    const manual = first.charts.add("line", {
      series: [{ name: "Manual", values: manualValues }],
    });
    manualValues[0] = Number.POSITIVE_INFINITY;
    expect(manual.series.items[0]!.values).toEqual([1]);
    expect(() =>
      first.charts.add("line", {
        series: [{ name: "Invalid", values: [Number.POSITIVE_INFINITY] }],
      }),
    ).toThrow(/finite/i);
    expect(() => {
      manual.position = {
        from: { row: -1, col: 0, rowCount: 1, colCount: 1 },
        to: { row: 0, col: 1, rowCount: 1, colCount: 1 },
      };
    }).toThrow(/integer/i);

    const format = { font: { size: 12 } };
    first.getRange("A1").format = format;
    format.font.size = 0;
    expect(first.cellData(0, 0).format.font?.size).toBe(12);
    expect(() => {
      first.getRange("A1").format = { font: { size: 0 } };
    }).toThrow(/positive/i);
    expect(() => {
      first.getRange("A1").format = {
        borders: { top: { weight: -1 } },
      };
    }).toThrow(/non-negative/i);

    const other = Workbook.create();
    const foreign = other.worksheets.add("Foreign");
    expect(() => workbook.comments.addThread({ cell: foreign.getRange("A1") }, "No")).toThrow(
      /another workbook/i,
    );

    const oversized = "x".repeat(SPREADSHEET_SNAPSHOT_LIMITS.stringBytesEach + 1);
    expect(() => {
      first.getRange("C1:D1").values = [["unchanged", oversized]];
    }).toThrow(/UTF-8 bytes/i);
    expect(first.cellData(0, 2).value).toBeNull();
    expect(() => {
      manual.title = oversized;
    }).toThrow(/UTF-8 bytes/i);
    const table = first.tables.add("A1:B2", true, "Data");
    expect(() => {
      table.style = oversized;
    }).toThrow(/UTF-8 bytes/i);
    expect(() => workbook.comments.setSelf({ displayName: oversized })).toThrow(/UTF-8 bytes/i);

    expect(() => validateSerializedWorkbook(workbook.toJSON())).not.toThrow();
    expect(() => Workbook.fromJSON(workbook.toJSON())).not.toThrow();
  });

  test("detaches Date inputs and reads from mutable caller state", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Dates");
    const source = new Date("2026-08-08T12:34:56.000Z");
    sheet.getRange("A1").values = [[source]];
    source.setUTCFullYear(2000);

    const firstRead = sheet.cellData(0, 0).value as Date;
    firstRead.setUTCFullYear(2001);
    expect(sheet.cellData(0, 0).value).toEqual(new Date("2026-08-08T12:34:56.000Z"));

    sheet.getRange("B1").formulas = [["=DATE(2026,8,8)"]];
    const formulaRead = sheet.getRange("B1").values[0]![0] as Date;
    formulaRead.setUTCFullYear(2002);
    expect(sheet.getRange("B1").values[0]![0]).toEqual(new Date("2026-08-08T00:00:00.000Z"));
    expect(() => sheet.setCell(0, 2, { value: new Date(Number.NaN) }, "content")).toThrow(/valid/i);
  });

  test("enforces live collection caps and releases reusable capacity", () => {
    const workbook = Workbook.create();
    for (let index = 0; index < SPREADSHEET_SNAPSHOT_LIMITS.sheets; index += 1) {
      workbook.worksheets.add(`S${index}`);
    }
    expect(() => workbook.worksheets.add("Overflow")).toThrow(/maximum/i);

    const sheet = workbook.worksheets.getItemAt(0);
    for (let index = 0; index < SPREADSHEET_SNAPSHOT_LIMITS.chartsPerSheet; index += 1) {
      sheet.charts.add("line");
    }
    expect(() => sheet.charts.add("line")).toThrow(/maximum/i);
    sheet.charts.deleteAll();
    expect(() => sheet.charts.add("line")).not.toThrow();

    const comments = Workbook.create();
    const commentSheet = comments.worksheets.add("Comments");
    const thread = comments.comments.addThread({ cell: commentSheet.getRange("A1") }, "First");
    for (let index = 1; index < SPREADSHEET_SNAPSHOT_LIMITS.commentsPerThread; index += 1) {
      thread.addReply("Reply");
    }
    expect(() => thread.addReply("Overflow")).toThrow(/maximum/i);
  });
});
