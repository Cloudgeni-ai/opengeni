import { describe, expect, test } from "bun:test";

import {
  SpreadsheetFidelityError,
  SpreadsheetFile,
  SpreadsheetSecurityError,
} from "../src/spreadsheet-file";
import { InvalidSpreadsheetImageError, Workbook } from "../src/spreadsheet";

describe("XLSX codec", () => {
  test("round-trips formulas, styles, structure, tables, validation, and images", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Summary");
    sheet.getRange("A1:C3").values = [
      ["Month", "Revenue", "Double"],
      ["Jan", 120, null],
      ["Feb", 140, null],
    ];
    sheet.getRange("C2").formulas = [["=B2*2"]];
    sheet.getRange("C2:C3").fillDown();
    sheet.getRange("A1:C1").format = {
      fill: "#0f766e",
      font: { name: "Arial", size: 14, bold: true, color: "#ffffff" },
      borders: { preset: "all", style: "thin", color: "#134e4a" },
      horizontalAlignment: "center",
    };
    sheet.getRange("B2:C3").format.numberFormat = "$#,##0";
    sheet.getRange("A2").dataValidation = {
      rule: { type: "list", values: ["Jan", "Feb", "Mar"], allowBlank: false },
    };
    sheet.getRange("B2:B3").conditionalFormats.add("cellIs", {
      operator: "greaterThan",
      formula: 100,
      format: { fill: "#DCFCE7", font: { bold: true, color: "#166534" } },
    });
    sheet.getRange("A1:C1").format.rowHeightPx = 32;
    sheet.getRange("A1:A3").format.columnWidthPx = 140;
    sheet.freezePanes.freezeRows(1);
    sheet.tables.add("A1:C3", true, "RevenueTable");
    sheet.images.add({
      dataUrl: ONE_PIXEL_PNG,
      contentType: "image/png",
      anchor: {
        from: { row: 4, col: 0, rowOffsetPx: 3, colOffsetPx: 4 },
        extent: { widthPx: 16, heightPx: 16 },
      },
    });

    const file = await SpreadsheetFile.exportXlsx(workbook, {
      fileName: "summary.xlsx",
    });
    expect(file.name).toBe("summary.xlsx");
    expect(file.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()).subarray(0, 4))).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);

    const imported = await SpreadsheetFile.importXlsx(file);
    const importedSheet = imported.worksheets.getItem("Summary");
    expect(importedSheet.getRange("A1:C3").formulas).toEqual([
      [null, null, null],
      [null, null, "=B2*2"],
      [null, null, "=B3*2"],
    ]);
    expect(importedSheet.getRange("A1:C3").values).toEqual([
      ["Month", "Revenue", "Double"],
      ["Jan", 120, 240],
      ["Feb", 140, 280],
    ]);
    expect(importedSheet.cellData(0, 0).format.fill).toBe("#0F766E");
    expect(importedSheet.cellData(0, 0).format.font?.bold).toBe(true);
    expect(importedSheet.cellData(1, 1).format.numberFormat).toBe("$#,##0");
    expect(importedSheet.freezePanes.snapshot()).toEqual({
      rows: 1,
      columns: 0,
    });
    expect(importedSheet.tables.items.map((table) => table.name)).toEqual(["RevenueTable"]);
    expect(importedSheet.dataValidations.get(importedSheet.getRange("A2").address)?.rule.type).toBe(
      "list",
    );
    expect(
      importedSheet.dataValidations.get(importedSheet.getRange("A2").address)?.rule.values,
    ).toEqual(["Jan", "Feb", "Mar"]);
    expect(importedSheet.conditionalFormattings.all()).toEqual([
      expect.objectContaining({
        range: importedSheet.getRange("B2:B3").address,
        ruleType: "cellIs",
        config: expect.objectContaining({
          operator: "greaterThan",
          formula: 100,
        }),
      }),
    ]);
    expect(importedSheet.images.items).toHaveLength(1);
    expect(importedSheet.images.items[0]?.config.contentType).toBe("image/png");
    expect(importedSheet.images.items[0]?.config.anchor.from.rowOffsetPx).toBeCloseTo(3, 4);
    expect(importedSheet.images.items[0]?.config.anchor.from.colOffsetPx).toBeCloseTo(4, 2);
  });

  test("requires explicit loss for threaded comment metadata and preserves note text", async () => {
    const workbook = Workbook.create();
    workbook.comments.setSelf({ displayName: "Reviewer" });
    const sheet = workbook.worksheets.add("Comments");
    const thread = workbook.comments.addThread({ cell: sheet.getRange("A1") }, "Confirm source");
    thread.addReply("Confirmed");
    thread.resolve();

    await expect(SpreadsheetFile.exportXlsx(workbook)).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "comment-thread-not-exportable" })],
    });
    const exported = await SpreadsheetFile.exportXlsx(workbook, {
      unsupportedContent: "discard",
    });
    const imported = await SpreadsheetFile.importXlsx(exported);
    expect(imported.comments.items).toHaveLength(1);
    expect(imported.comments.items[0]?.comments[0]?.text).toBe("Confirm source\n\nConfirmed");
  });

  test("requires explicit loss for image accessibility metadata ExcelJS cannot author", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Images");
    sheet.images.add({
      dataUrl: ONE_PIXEL_PNG,
      contentType: "image/png",
      alt: "Status indicator",
      anchor: {
        from: { row: 0, col: 0 },
        extent: { widthPx: 16, heightPx: 16 },
      },
    });
    await expect(SpreadsheetFile.exportXlsx(workbook)).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "image-metadata-not-exportable" })],
    });
    expect(
      (
        await SpreadsheetFile.exportXlsx(workbook, {
          unsupportedContent: "discard",
        })
      ).size,
    ).toBeGreaterThan(1_000);
  });

  test("binds portable source envelopes to exact bytes, metadata, and model projection", async () => {
    const source = Workbook.create();
    source.worksheets.add("Bound").getRange("A1").values = [["original"]];
    const plain = new Uint8Array(await (await SpreadsheetFile.exportXlsx(source)).arrayBuffer());
    const withOpaque = appendStoredZipEntry(
      plain,
      "customXml/item1.xml",
      new TextEncoder().encode('<custom xmlns="urn:opengeni:test">safe inert data</custom>'),
    );
    const imported = await SpreadsheetFile.importXlsx(withOpaque);
    expect(SpreadsheetFile.fidelityReport(imported)).toEqual([
      expect.objectContaining({
        code: "content-preserved-in-source",
        feature: "opaque-ooxml",
        parts: ["customXml/item1.xml"],
        features: ["custom-xml"],
      }),
    ]);
    const firstEnvelope = SpreadsheetFile.lossPreservationEnvelope(imported)!;

    firstEnvelope.sourceBytes[0] = firstEnvelope.sourceBytes[0]! ^ 0xff;
    (firstEnvelope.opaqueContent.parts as string[]).length = 0;
    expect(
      new Uint8Array(await (await SpreadsheetFile.exportXlsx(imported)).arrayBuffer()),
    ).toEqual(Uint8Array.from(withOpaque));

    const envelope = SpreadsheetFile.lossPreservationEnvelope(imported)!;
    const restored = Workbook.fromJSON(imported.toJSON());
    const wrongBytes = {
      ...envelope,
      sourceBytes: envelope.sourceBytes.slice(),
    };
    wrongBytes.sourceBytes[0] = wrongBytes.sourceBytes[0]! ^ 0xff;
    await expect(
      SpreadsheetFile.attachLossPreservationEnvelope(restored, wrongBytes),
    ).rejects.toMatchObject({ code: "invalid-package" });

    await expect(
      SpreadsheetFile.attachLossPreservationEnvelope(restored, {
        ...envelope,
        opaqueContent: {
          ...envelope.opaqueContent,
          features: [...envelope.opaqueContent.features, "invented-feature"],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-package" });

    await expect(
      SpreadsheetFile.attachLossPreservationEnvelope(restored, {
        ...envelope,
        modelDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "invalid-package" });
  });

  test("emits deterministic XLSX bytes and survives repeated edit cycles", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Cycle");
    sheet.getRange("A1:B3").values = [
      ["Input", "Double"],
      [2, null],
      [3, null],
    ];
    sheet.getRange("B2").formulas = [["=A2*2"]];
    sheet.getRange("B2:B3").fillDown();
    sheet.getRange("A1:B1").format = { fill: "#123456", font: { bold: true } };

    const first = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const second = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    expect(second).toEqual(first);
    expect(zipTimestamps(first)).toEqual([{ time: 0, date: 0x21 }]);

    const editedOnce = await SpreadsheetFile.importXlsx(first);
    expect(SpreadsheetFile.fidelityReport(editedOnce)).toEqual([]);
    editedOnce.worksheets.getItem("Cycle").getRange("A2").values = [[5]];
    const once = await SpreadsheetFile.exportXlsx(editedOnce);
    const editedTwice = await SpreadsheetFile.importXlsx(once);
    editedTwice.worksheets.getItem("Cycle").getRange("A3").values = [[7]];
    const twice = await SpreadsheetFile.importXlsx(await SpreadsheetFile.exportXlsx(editedTwice));
    expect(twice.worksheets.getItem("Cycle").getRange("A1:B3").values).toEqual([
      ["Input", "Double"],
      [5, 10],
      [7, 14],
    ]);
    expect(twice.worksheets.getItem("Cycle").cellData(0, 0).format.fill).toBe("#123456");
  });

  test("never silently drops editable chart OOXML", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Data");
    sheet.getRange("A1:B2").values = [
      ["Month", "Revenue"],
      ["Jan", 100],
    ];
    const plain = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
    const withChartPart = appendStoredZipEntry(
      plain,
      "xl/charts/chart1.xml",
      new TextEncoder().encode(
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
      ),
    );

    const imported = await SpreadsheetFile.importXlsx(withChartPart);
    expect(SpreadsheetFile.fidelityReport(imported)).toEqual([
      expect.objectContaining({
        code: "editable-chart-preserved",
        severity: "warning",
        parts: ["xl/charts/chart1.xml"],
      }),
    ]);
    const unchanged = new Uint8Array(
      await (await SpreadsheetFile.exportXlsx(imported)).arrayBuffer(),
    );
    expect(unchanged).toEqual(Uint8Array.from(withChartPart));

    const envelope = SpreadsheetFile.lossPreservationEnvelope(imported);
    expect(envelope).not.toBeNull();
    const restored = Workbook.fromJSON(imported.toJSON());
    await SpreadsheetFile.attachLossPreservationEnvelope(restored, envelope!);
    expect(
      new Uint8Array(await (await SpreadsheetFile.exportXlsx(restored)).arrayBuffer()),
    ).toEqual(Uint8Array.from(withChartPart));
    const reorderedEnvelope = {
      ...envelope!,
      opaqueContent: {
        ...envelope!.opaqueContent,
        parts: [...envelope!.opaqueContent.parts].reverse(),
      },
    };
    const reorderedRestored = Workbook.fromJSON(imported.toJSON());
    await SpreadsheetFile.attachLossPreservationEnvelope(reorderedRestored, reorderedEnvelope);
    expect(
      new Uint8Array(await (await SpreadsheetFile.exportXlsx(reorderedRestored)).arrayBuffer()),
    ).toEqual(Uint8Array.from(withChartPart));
    const unrelated = Workbook.create();
    unrelated.worksheets.add("Other").getRange("A1").values = [["different"]];
    await expect(
      SpreadsheetFile.attachLossPreservationEnvelope(unrelated, envelope!),
    ).rejects.toMatchObject({ code: "invalid-package" });

    let reads = 0;
    const hostile = { ...envelope! };
    Object.defineProperty(hostile, "opaqueContent", {
      enumerable: true,
      get() {
        reads += 1;
        return envelope!.opaqueContent;
      },
    });
    await expect(SpreadsheetFile.attachLossPreservationEnvelope(restored, hostile)).rejects.toThrow(
      /plain data/i,
    );
    expect(reads).toBe(0);

    imported.worksheets.getItem("Data").getRange("B2").values = [[101]];
    await expect(SpreadsheetFile.exportXlsx(imported)).rejects.toBeInstanceOf(
      SpreadsheetFidelityError,
    );
    const explicitLoss = await SpreadsheetFile.exportXlsx(imported, {
      unsupportedContent: "discard",
    });
    expect(explicitLoss.size).toBeGreaterThan(1_000);
  });

  test("rejects agent-created editable charts unless loss is explicit", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Data");
    sheet.getRange("A1:B2").values = [
      ["Month", "Revenue"],
      ["Jan", 100],
    ];
    sheet.charts.add("bar", sheet.getRange("A1:B2"));

    await expect(SpreadsheetFile.exportXlsx(workbook)).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "editable-chart-not-exportable" })],
    });
    expect(
      (
        await SpreadsheetFile.exportXlsx(workbook, {
          unsupportedContent: "discard",
        })
      ).size,
    ).toBeGreaterThan(1_000);
  });

  test("preserves imported sparkline OOXML exactly and requires explicit loss after edits", async () => {
    const plain = await plainXlsx();
    const sparklinePart = "xl/worksheets/sparklineFixture.xml";
    const withSparklines = appendStoredZipEntry(
      plain,
      sparklinePart,
      new TextEncoder().encode(
        '<worksheet xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><extLst><ext><x14:sparklineGroups><x14:sparklineGroup/></x14:sparklineGroups></ext></extLst></worksheet>',
      ),
    );

    const imported = await SpreadsheetFile.importXlsx(withSparklines);
    expect(SpreadsheetFile.fidelityReport(imported)).toEqual([
      expect.objectContaining({
        code: "sparkline-preserved",
        severity: "warning",
        feature: "sparkline",
        parts: [sparklinePart],
      }),
    ]);
    expect(
      new Uint8Array(await (await SpreadsheetFile.exportXlsx(imported)).arrayBuffer()),
    ).toEqual(Uint8Array.from(withSparklines));
    expect(SpreadsheetFile.lossPreservationEnvelope(imported)?.opaqueContent.parts).toContain(
      sparklinePart,
    );

    await expect(
      SpreadsheetFile.importXlsx(withSparklines, {
        unsupportedContent: "error",
      }),
    ).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "sparkline-not-exportable" })],
    });

    imported.worksheets.getItem("Sheet1").getRange("A1").values = [["changed"]];
    await expect(SpreadsheetFile.exportXlsx(imported)).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "sparkline-not-exportable" })],
    });
    expect(
      (
        await SpreadsheetFile.exportXlsx(imported, {
          unsupportedContent: "discard",
        })
      ).size,
    ).toBeGreaterThan(1_000);
  });

  test("requires explicit loss before exporting model-authored sparklines", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Trends");
    sheet.getRange("A1:C1").values = [[1, 2, 3]];
    sheet.getRange("D1").sparklines.add("line", "A1:C1");

    await expect(SpreadsheetFile.exportXlsx(workbook)).rejects.toMatchObject({
      name: "SpreadsheetFidelityError",
      issues: [expect.objectContaining({ code: "sparkline-not-exportable" })],
    });
    const discarded = await SpreadsheetFile.exportXlsx(workbook, {
      unsupportedContent: "discard",
    });
    const imported = await SpreadsheetFile.importXlsx(discarded);
    expect(imported.worksheets.getItem("Trends").sparklineGroups.items).toHaveLength(0);
    expect(imported.worksheets.getItem("Trends").getRange("A1:C1").values).toEqual([[1, 2, 3]]);
  });
});

describe("XLSX security preflight", () => {
  test("rejects active content, OLE embeddings, and external relationships before ExcelJS", async () => {
    const plain = await plainXlsx();
    const macro = appendStoredZipEntry(plain, "xl/vbaProject.bin", new Uint8Array([1, 2, 3]));
    await expect(SpreadsheetFile.importXlsx(macro)).rejects.toMatchObject({
      name: "SpreadsheetSecurityError",
      code: "active-content",
      entryName: "xl/vbaProject.bin",
    });

    const ole = appendStoredZipEntry(plain, "xl/embeddings/oleObject1.bin", new Uint8Array([1]));
    await expect(SpreadsheetFile.importXlsx(ole)).rejects.toMatchObject({
      code: "active-content",
    });

    const relationships = new TextEncoder().encode(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="attachedTemplate" Target="https://example.invalid/template" TargetMode="External"/></Relationships>',
    );
    const external = appendStoredZipEntry(
      plain,
      "xl/worksheets/_rels/unsafe.xml.rels",
      relationships,
    );
    await expect(SpreadsheetFile.importXlsx(external)).rejects.toMatchObject({
      code: "external-relationship",
      entryName: "xl/worksheets/_rels/unsafe.xml.rels",
    });
  });

  test("rejects entity declarations, encrypted entries, and configurable limit violations", async () => {
    const plain = await plainXlsx();
    const entity = appendStoredZipEntry(
      plain,
      "xl/unsafe.xml",
      new TextEncoder().encode(
        '<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///etc/passwd">]><x>&ex;</x>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(entity)).rejects.toMatchObject({
      code: "unsafe-xml",
      entryName: "xl/unsafe.xml",
    });

    const encrypted = markFirstEntryEncrypted(plain);
    await expect(SpreadsheetFile.importXlsx(encrypted)).rejects.toMatchObject({
      code: "encrypted-content",
    });

    await expect(
      SpreadsheetFile.importXlsx(plain, {
        limits: { compressedBytes: plain.byteLength - 1 },
      }),
    ).rejects.toBeInstanceOf(SpreadsheetSecurityError);
    let hostileReads = 0;
    class HostileBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        hostileReads += 1;
        return await super.arrayBuffer();
      }
    }
    await expect(
      SpreadsheetFile.importXlsx(new HostileBlob([Uint8Array.from(plain).buffer]), {
        limits: { compressedBytes: plain.byteLength - 1 },
      }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(hostileReads).toBe(0);
    await expect(
      SpreadsheetFile.importXlsx(plain, { limits: { entries: 1 } }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  test("never emits remote-fetching formulas or unsafe image sources", async () => {
    for (const formula of [
      '=WEBSERVICE("https://example.invalid")',
      '=HYPERLINK(CHAR(104)&"ttps://example.invalid","open")',
      "=cmd|' /c calc'!A1",
      "='[external.xlsx]Sheet1'!A1",
      '=STOCKHISTORY("MSFT")',
    ]) {
      const formulaWorkbook = Workbook.create();
      formulaWorkbook.worksheets.add("Sheet1").getRange("A1").formulas = [[formula]];
      await expect(SpreadsheetFile.exportXlsx(formulaWorkbook)).rejects.toMatchObject({
        code: "active-content",
      });
    }

    const imageWorkbook = Workbook.create();
    const imageSheet = imageWorkbook.worksheets.add("Sheet1");
    expect(() =>
      imageSheet.images.add({
        dataUrl: "https://example.invalid/remote.png",
        contentType: "image/png",
        anchor: {
          from: { row: 0, col: 0 },
          extent: { widthPx: 10, heightPx: 10 },
        },
      }),
    ).toThrow(InvalidSpreadsheetImageError);

    const bypassedItems = imageSheet.images.items as unknown as Array<{
      config: {
        dataUrl: string;
        contentType: string;
        anchor: {
          from: { row: number; col: number };
          extent: { widthPx: number; heightPx: number };
        };
      };
    }>;
    bypassedItems.push({
      config: {
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        contentType: "image/png",
        anchor: {
          from: { row: 0, col: 0 },
          extent: { widthPx: 10, heightPx: 10 },
        },
      },
    });
    await expect(SpreadsheetFile.exportXlsx(imageWorkbook)).rejects.toMatchObject({
      code: "active-content",
    });
  });

  test("parses formula text and relationship semantics instead of relying on denylist text", async () => {
    const plain = await plainXlsx();
    const activeFormulaParts = [
      '<worksheet><f>HYPE&#82;LINK(CHAR(104)&amp;"ttps://example.invalid","open")</f></worksheet>',
      '<worksheet xmlns:x="urn:test"><x:f>cmd|&apos; /c calc&apos;!A1</x:f></worksheet>',
      "<worksheet><f>&apos;[external.xlsx]Sheet1&apos;!A1</f></worksheet>",
      '<worksheet><definedName>STOCKHISTORY("MSFT")</definedName></worksheet>',
    ];
    for (const [index, xml] of activeFormulaParts.entries()) {
      await expect(
        SpreadsheetFile.importXlsx(
          appendStoredZipEntry(
            plain,
            `xl/worksheets/active-formula-${index}.xml`,
            new TextEncoder().encode(xml),
          ),
        ),
      ).rejects.toMatchObject({ code: "active-content" });
    }

    const disguisedOleRelationship = appendStoredZipEntry(
      plain,
      "xl/worksheets/_rels/sheet1.xml.rels",
      new TextEncoder().encode(
        '<?xml version="1.0"?><r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObj&#101;ct" Target="../styles.xml"/></r:Relationships>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(disguisedOleRelationship)).rejects.toMatchObject({
      code: "active-content",
      entryName: "xl/worksheets/_rels/sheet1.xml.rels",
    });

    const wrongTargetForSafeType = appendStoredZipEntry(
      plain,
      "xl/worksheets/_rels/sheet1.xml.rels",
      new TextEncoder().encode(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../styles.xml"/></Relationships>',
      ),
    );
    await expect(SpreadsheetFile.importXlsx(wrongTargetForSafeType)).rejects.toMatchObject({
      code: "active-content",
    });
  });

  test("rejects duplicate names, local metadata mismatches, overlaps, and checksum corruption", async () => {
    const plain = await plainXlsx();
    const duplicate = appendStoredZipEntry(
      plain,
      "[Content_Types].xml",
      new TextEncoder().encode("<Types/>"),
    );
    await expect(SpreadsheetFile.importXlsx(duplicate)).rejects.toMatchObject({
      code: "invalid-package",
    });

    const mismatched = plain.slice();
    const mismatchView = new DataView(mismatched.buffer);
    const first = centralEntries(mismatched)[0]!;
    const centralCompression = mismatchView.getUint16(first.centralOffset + 10, true);
    mismatchView.setUint16(first.localOffset + 8, centralCompression === 0 ? 8 : 0, true);
    await expect(SpreadsheetFile.importXlsx(mismatched)).rejects.toMatchObject({
      code: "invalid-package",
    });

    const corrupt = appendStoredZipEntry(plain, "xl/safe.xml", new TextEncoder().encode("<safe/>"));
    const corruptEntry = centralEntries(corrupt).find((entry) => entry.name === "xl/safe.xml")!;
    corrupt[localDataStart(corrupt, corruptEntry.localOffset)]! ^= 0xff;
    await expect(SpreadsheetFile.importXlsx(corrupt)).rejects.toMatchObject({
      code: "invalid-package",
      entryName: "xl/safe.xml",
    });

    let overlapping = appendStoredZipEntry(plain, "xl/a.dat", new Uint8Array([1]));
    overlapping = appendStoredZipEntry(overlapping, "xl/b.dat", new Uint8Array([2]));
    const overlappingView = new DataView(overlapping.buffer);
    const overlappingEntries = centralEntries(overlapping);
    const a = overlappingEntries.find((entry) => entry.name === "xl/a.dat")!;
    const b = overlappingEntries.find((entry) => entry.name === "xl/b.dat")!;
    const aDataStart = localDataStart(overlapping, a.localOffset);
    const expanded = b.localOffset - aDataStart + 1;
    overlappingView.setUint32(a.centralOffset + 20, expanded, true);
    overlappingView.setUint32(a.centralOffset + 24, expanded, true);
    overlappingView.setUint32(a.localOffset + 18, expanded, true);
    overlappingView.setUint32(a.localOffset + 22, expanded, true);
    await expect(SpreadsheetFile.importXlsx(overlapping)).rejects.toMatchObject({
      code: "invalid-package",
    });
  });

  test("bounds XML attributes and relationship counts per part and package", async () => {
    const plain = await plainXlsx();
    const attributes = Array.from({ length: 257 }, (_, index) => ` a${index}="x"`).join("");
    const excessiveAttributes = appendStoredZipEntry(
      plain,
      "xl/excessive-attributes.xml",
      new TextEncoder().encode(`<x${attributes}/>`),
    );
    await expect(SpreadsheetFile.importXlsx(excessiveAttributes)).rejects.toMatchObject({
      code: "limit-exceeded",
      entryName: "xl/excessive-attributes.xml",
    });

    const relationshipXml = new TextEncoder().encode(
      `<Relationships>${Array.from(
        { length: 4_097 },
        (_, index) => `<Relationship Id="r${index}" Target="target${index}"/>`,
      ).join("")}</Relationships>`,
    );
    const excessiveRelationships = appendStoredZipEntry(plain, "xl/too-many.rels", relationshipXml);
    await expect(SpreadsheetFile.importXlsx(excessiveRelationships)).rejects.toMatchObject({
      code: "limit-exceeded",
      entryName: "xl/too-many.rels",
    });
  });

  test("bounds compact XML node and worksheet-cell bombs before ExcelJS", async () => {
    const plain = await plainXlsx();
    const cells = Array.from(
      { length: 5 },
      (_, index) => `<c r="${String.fromCharCode(65 + index)}1"><v>${index}</v></c>`,
    ).join("");
    const bomb = appendStoredZipEntry(
      plain,
      "xl/worksheets/cell-bomb.xml",
      new TextEncoder().encode(`<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`),
    );
    await expect(
      SpreadsheetFile.importXlsx(bomb, {
        limits: { worksheetCellsPerPart: 4 },
      }),
    ).rejects.toMatchObject({
      code: "limit-exceeded",
      entryName: "xl/worksheets/cell-bomb.xml",
    });
    await expect(
      SpreadsheetFile.importXlsx(plain, {
        limits: { xmlElementsPerPart: 1_000_001 },
      }),
    ).rejects.toThrow(/hard safety cap/i);
  });

  test("enforces aggregate formula, XML, style, and decoded-media budgets", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Aggregates");
    sheet.getRange("A1:B2").values = [
      [1, null],
      [2, null],
    ];
    sheet.getRange("B1").formulas = [["=A1*2"]];
    sheet.getRange("B1:B2").fillDown();
    for (const row of [3, 4]) {
      sheet.images.add({
        dataUrl: ONE_PIXEL_PNG,
        contentType: "image/png",
        anchor: { from: { row, col: 0 }, extent: { widthPx: 1, heightPx: 1 } },
      });
    }
    const bytes = new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());

    for (const limits of [
      { formulas: 1 },
      { formulaBytes: 4 },
      { xmlTextCharacters: 1 },
      { styleRecords: 1 },
      { mediaEntries: 1 },
      { mediaBytes: 100 },
      { imagePixels: 1 },
    ]) {
      await expect(SpreadsheetFile.importXlsx(bytes, { limits })).rejects.toMatchObject({
        code: "limit-exceeded",
      });
    }
  });

  test("validates option bags without invoking accessors", async () => {
    const bytes = await plainXlsx();
    let reads = 0;
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "limits", {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    });
    await expect(SpreadsheetFile.importXlsx(bytes, hostile as never)).rejects.toThrow(
      /data properties/i,
    );
    expect(reads).toBe(0);
    await expect(
      SpreadsheetFile.importXlsx(bytes, { limits: { unknown: 1 } as never }),
    ).rejects.toThrow(/unknown property/i);
  });
});

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function plainXlsx(): Promise<Uint8Array> {
  const workbook = Workbook.create();
  workbook.worksheets.add("Sheet1").getRange("A1").values = [["safe"]];
  return new Uint8Array(await (await SpreadsheetFile.exportXlsx(workbook)).arrayBuffer());
}

function zipTimestamps(source: Uint8Array): Array<{ time: number; date: number }> {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const values = new Map<string, { time: number; date: number }>();
  for (const entry of centralEntries(source)) {
    const time = view.getUint16(entry.centralOffset + 12, true);
    const date = view.getUint16(entry.centralOffset + 14, true);
    const localTime = view.getUint16(entry.localOffset + 10, true);
    const localDate = view.getUint16(entry.localOffset + 12, true);
    expect({ localTime, localDate }).toEqual({
      localTime: time,
      localDate: date,
    });
    values.set(`${time}:${date}`, { time, date });
  }
  return [...values.values()];
}

function appendStoredZipEntry(source: Uint8Array, name: string, payload: Uint8Array): Uint8Array {
  const endOffset = findEndOfCentralDirectory(source);
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const count = sourceView.getUint16(endOffset + 10, true);
  const centralSize = sourceView.getUint32(endOffset + 12, true);
  const centralOffset = sourceView.getUint32(endOffset + 16, true);
  const nameBytes = new TextEncoder().encode(name);
  const checksum = crc32(payload);

  const local = new Uint8Array(30 + nameBytes.length + payload.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(14, checksum, true);
  localView.setUint32(18, payload.length, true);
  localView.setUint32(22, payload.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(payload, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, payload.length, true);
  centralView.setUint32(24, payload.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, centralOffset, true);
  central.set(nameBytes, 46);

  const nextCentralOffset = centralOffset + local.length;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, count + 1, true);
  endView.setUint16(10, count + 1, true);
  endView.setUint32(12, centralSize + central.length, true);
  endView.setUint32(16, nextCentralOffset, true);

  return concat(
    source.subarray(0, centralOffset),
    local,
    source.subarray(centralOffset, endOffset),
    central,
    end,
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end record not found");
}

function markFirstEntryEncrypted(source: Uint8Array): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer);
  const end = findEndOfCentralDirectory(bytes);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint32(centralOffset, true) !== 0x02014b50)
    throw new Error("ZIP central entry not found");
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint16(centralOffset + 8, view.getUint16(centralOffset + 8, true) | 1, true);
  view.setUint16(localOffset + 6, view.getUint16(localOffset + 6, true) | 1, true);
  return bytes;
}

type CentralEntry = {
  name: string;
  centralOffset: number;
  localOffset: number;
};

function centralEntries(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(bytes);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid central entry");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      centralOffset: offset,
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function localDataStart(bytes: Uint8Array, localOffset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    localOffset +
    30 +
    view.getUint16(localOffset + 26, true) +
    view.getUint16(localOffset + 28, true)
  );
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
