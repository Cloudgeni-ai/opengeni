import { describe, expect, test } from "bun:test";

import { Workbook, validateSerializedWorkbook } from "../src/spreadsheet";

describe("spreadsheet sparklines", () => {
  test("supports skill-compatible creation, cross-sheet sources, inspection, and exact snapshots", async () => {
    const workbook = Workbook.create();
    const data = workbook.worksheets.add("Data Sheet");
    const dashboard = workbook.worksheets.add("Dashboard");
    data.getRange("A1:C2").values = [
      [1, null, 3],
      [-2, 0, 4],
    ];
    data.getRange("A4:C4").values = [
      [new Date("2026-01-01"), new Date("2026-02-01"), new Date("2026-03-01")],
    ];

    const group = dashboard.sparklineGroups.add({
      type: "line",
      targetRange: "B2:B3",
      sourceData: "'Data Sheet'!A1:C2",
      dateAxisRange: "'Data Sheet'!A4:C4",
      lineWeight: 1.5,
      displayHidden: true,
      displayEmptyCellsAs: 1,
      seriesColor: "abc",
      negativeColor: "FF112233",
      axisColor: "#445566",
      markersColor: "#778899",
      firstMarkerColor: "#010203",
      lastMarkerColor: "#040506",
      highMarkerColor: "#070809",
      lowMarkerColor: "#0a0b0c",
      markers: { show: true, high: true, low: true, first: true, last: true, negative: true },
      axis: { showAxis: true, manualMin: -10, manualMax: 10, rightToLeft: true },
    });

    expect(dashboard.sparklines).toBe(dashboard.sparklineGroups);
    expect(group.valuesForTargetCell(1, 1)).toEqual([1, 0, 3]);
    expect(group.valuesForTargetCell(2, 1)).toEqual([-2, 0, 4]);
    expect(group.valuesForTargetCell(0, 0)).toEqual([]);
    expect(group.dateAxisValues()).toEqual([
      Date.parse("2026-01-01"),
      Date.parse("2026-02-01"),
      Date.parse("2026-03-01"),
    ]);
    expect(group.seriesColor).toBe("#AABBCC");
    expect(group.negativeColor).toBe("#112233");
    expect(group.axis).toEqual({
      showAxis: true,
      manualMin: -10,
      manualMax: 10,
      rightToLeft: true,
    });

    const inspected = await workbook.inspect({ kind: "sparkline", sheetId: "Dashboard" });
    expect(inspected.records).toEqual([
      expect.objectContaining({
        kind: "drawing",
        objectKind: "sparklineGroup",
        id: group.id,
        targetRange: "B2:B3",
        sourceData: { sheetId: data.id, sheetName: "Data Sheet", range: "A1:C2" },
        colors: {
          series: "#AABBCC",
          negative: "#112233",
          axis: "#445566",
          markers: "#778899",
          first: "#010203",
          last: "#040506",
          high: "#070809",
          low: "#0A0B0C",
        },
      }),
    ]);
    expect(workbook.resolve(group.id)).toBe(group);

    const snapshot = workbook.toJSON();
    validateSerializedWorkbook(snapshot);
    const restored = Workbook.fromJSON(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.toJSON()).toEqual(snapshot);
    const restoredGroup = restored.worksheets.getItem("Dashboard").sparklineGroups.items[0]!;
    expect(restored.resolve(group.id)).toBe(restoredGroup);
    expect(restoredGroup.valuesForTargetCell(2, 1)).toEqual([-2, 0, 4]);

    const alias = restored.worksheets
      .getItem("Dashboard")
      .getRange("D2:D3")
      .sparklines.add("column", "'Data Sheet'!A1:C2");
    expect(alias.type).toBe("column");
    alias.delete();
    expect(restored.worksheets.getItem("Dashboard").sparklineGroups.items).toHaveLength(1);
  });

  test("renders deterministic line, column, and stacked sparklines without expanding the viewport", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Trends");
    sheet.getRange("A1:D3").values = [
      [1, 3, null, 2],
      [-2, 0, 4, 3],
      [-1, 1, -1, 1],
    ];
    sheet.getRange("E1:E3").format.columnWidthPx = 120;
    sheet.getRange("E1:E3").format.rowHeightPx = 36;
    const line = sheet.getRange("E1").sparklines.add("line", sheet.getRange("A1:D1"), {
      displayEmptyCellsAs: 2,
      markers: { show: true },
      seriesColor: "#123456",
    });
    const column = sheet.getRange("E2").sparklines.add("column", "A2:D2", {
      negativeColor: "#AA0000",
      axis: { showAxis: true },
    });
    const stacked = sheet.getRange("E3").sparklines.add("stacked", "A3:D3", {
      axis: { showAxis: true },
    });

    const first = await workbook.render({ sheetName: "Trends", range: "E1:E3", format: "svg" });
    const second = await workbook.render({ sheetName: "Trends", range: "E1:E3", format: "svg" });
    const svg = await first.text();
    expect(svg).toBe(await second.text());
    for (const group of [line, column, stacked]) {
      expect(svg).toContain(`data-opengeni-sparkline="${group.id}"`);
    }
    expect(svg).toContain("#123456");
    expect(svg).toContain("#AA0000");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("<circle");
    expect(svg).toContain("<rect");
  });

  test("rejects ambiguous geometry, overlaps, foreign ranges, and hostile configuration atomically", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Sheet1");
    sheet.getRange("A1:C2").values = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const foreign = Workbook.create().worksheets.add("Foreign").getRange("A1:C1");

    expect(() =>
      sheet.sparklineGroups.add({
        type: "line",
        targetRange: "D1:E2",
        sourceData: "A1:C2",
      }),
    ).toThrow(/one row or one column/i);
    expect(() =>
      sheet.sparklineGroups.add({ type: "line", targetRange: "D1:D2", sourceData: "A1:C1" }),
    ).toThrow(/one row for each vertical target/i);
    expect(() =>
      sheet.sparklineGroups.add({ type: "line", targetRange: "D1", sourceData: foreign }),
    ).toThrow(/another workbook/i);

    const original = sheet.sparklineGroups.add({
      type: "line",
      targetRange: "D1:D2",
      sourceData: "A1:C2",
    });
    expect(() =>
      sheet.sparklineGroups.add({ type: "column", targetRange: "D2", sourceData: "A1:C1" }),
    ).toThrow(/overlaps/i);
    expect(() => {
      original.axis = { manualMin: 2, manualMax: 1 };
    }).toThrow(/less than/i);
    expect(() => {
      original.seriesColor = "url(javascript:alert(1))";
    }).toThrow(/hexadecimal/i);
    expect(sheet.sparklineGroups.items).toEqual([original]);

    let reads = 0;
    const hostile = { type: "line", targetRange: "E1", sourceData: "A1:C1" };
    Object.defineProperty(hostile, "seriesColor", {
      enumerable: true,
      get() {
        reads += 1;
        return "#000000";
      },
    });
    expect(() => sheet.sparklineGroups.add(hostile as never)).toThrow(/plain data property/i);
    expect(reads).toBe(0);
    expect(sheet.sparklineGroups.items).toEqual([original]);
  });
});
