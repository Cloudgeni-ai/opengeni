import { describe, expect, test as bunTest } from "bun:test";

import {
  Document,
  DocumentFile,
  DocumentTextRun,
  Presentation,
  PresentationFile,
  SpreadsheetFile,
  Workbook,
  configureArtifactRuntime,
  disposeArtifact,
  getArtifactCompositeDiagnostics,
} from "../src";
import {
  Document as ReferenceDocument,
  DocumentFile as ReferenceDocumentFile,
} from "../src/document";
import {
  Presentation as ReferencePresentation,
  PresentationFile as ReferencePresentationFile,
} from "../src/presentation";
import { Workbook as ReferenceWorkbook } from "../src/spreadsheet";
import {
  decodePresentationArtifactQueryResponse,
  encodePresentationArtifactQuery,
} from "@opengeni/contracts/presentation-artifact-commands";
import {
  NativeDocumentSession,
  NativePresentationSession,
  NativeSpreadsheetSession,
} from "../src/native";
import { requireCompositeState } from "../src/production-composite";
import { encodePresentationProjectionCommands } from "../src/production-native-codecs";
import {
  productionTestRuntime,
  productionTestRuntimeAvailable,
} from "./production-runtime-fixture";

const nativeRuntimeAvailable = productionTestRuntimeAvailable();
const test = nativeRuntimeAvailable ? bunTest : bunTest.skip;
if (nativeRuntimeAvailable) configureArtifactRuntime(productionTestRuntime());

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("production facade over the real native addon", () => {
  test("keeps spreadsheet skill objects and native formulas in one atomic projection", () => {
    const workbook = Workbook.create();
    expect(workbook).toBeInstanceOf(Workbook);
    const sheet = workbook.worksheets.add("Summary");
    sheet.getRange("A1:B3").values = [
      ["Value", "Double"],
      [10, null],
      [12, null],
    ];
    sheet.getRange("B2:B3").formulas = [["=A2*2"], ["=A3*2"]];
    expect(sheet.getRange("A1:B3").values).toEqual([
      ["Value", "Double"],
      [10, 20],
      [12, 24],
    ]);
    expect(sheet.getRange("B2:B3").formulas).toEqual([["=A2*2"], ["=A3*2"]]);

    const acceptedRevision = workbook.revision;
    const authoredDate = new Date("2026-01-01T12:34:56.789Z");
    const formulaDate = new Date("2026-01-02T00:00:00.000Z");
    sheet.getRange("A2").values = [[authoredDate]];
    sheet.getRange("B2").formulas = [["=DATE(2026,1,2)"]];
    expect(workbook.revision).toBe(acceptedRevision + 2);
    expect(sheet.getRange("A2:B2").values).toEqual([[authoredDate, formulaDate]]);
    expect(sheet.getRange("B2").formulas).toEqual([["=DATE(2026,1,2)"]]);

    const diagnostics = getArtifactCompositeDiagnostics(workbook);
    expect(diagnostics.modality).toBe("spreadsheet");
    expect(diagnostics.nativeStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(diagnostics.nativeSnapshot.slice(0, 8)).toEqual(new TextEncoder().encode("OGACRD01"));
    const reopened = NativeSpreadsheetSession.open(
      productionTestRuntime(),
      diagnostics.nativeSnapshot,
    );
    expect(reopened.stateHash()).toBe(diagnostics.nativeStateHash);
    expect(reopened.snapshot()).toEqual(diagnostics.nativeSnapshot);
    reopened.dispose();
    disposeArtifact(workbook);
    expect(() => workbook.worksheets).toThrow("disposed");
  });

  test("matches reference formula and date semantics through the public spreadsheet API", () => {
    const reference = ReferenceWorkbook.create();
    const production = Workbook.create();
    for (const workbook of [reference, production]) {
      const sheet = workbook.worksheets.add("Parity");
      sheet.getRange("A1:A4").values = [[1], [2], [3], [new Date("2026-08-09T12:34:56.789Z")]];
      sheet.getRange("B1:B9").formulas = [
        ["=SUM(A1:A3)"],
        ["=AVERAGE(A1:A3)"],
        ["=IF(A1=1,7,9)"],
        ["=ROUND(2.55,1)"],
        ['=LEN("A😀")'],
        ['=CONCAT("a",A1,"b")'],
        ["=DATE(2024,2,29)"],
        ["=YEAR(A4)"],
        ["=A4>DATE(2026,8,9)"],
      ];
    }

    const referenceValues = reference.worksheets.getItem("Parity").getRange("B1:B9").values;
    const productionValues = production.worksheets.getItem("Parity").getRange("B1:B9").values;
    expect(normalizeCellDates(productionValues)).toEqual(normalizeCellDates(referenceValues));
    const calculatedDate = productionValues[6]?.[0];
    expect(calculatedDate).toBeInstanceOf(Date);
    if (!(calculatedDate instanceof Date)) throw new TypeError("DATE did not return a Date");
    expect(calculatedDate.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    disposeArtifact(production);
  });

  test("round-trips authored and calculated dates through XLSX without numeric collapse", async () => {
    const source = Workbook.create();
    const sheet = source.worksheets.add("Dates");
    sheet.getRange("A1").values = [[new Date("2026-08-09T12:34:56.789Z")]];
    sheet.getRange("A1:B1").format.numberFormat = "yyyy-mm-dd hh:mm:ss.000";
    sheet.getRange("B1").formulas = [["=DATE(2024,2,29)"]];

    const restored = await SpreadsheetFile.importXlsx(
      await SpreadsheetFile.exportXlsx(source, { fileName: "dates.xlsx" }),
    );
    const restoredSheet = restored.worksheets.getItem("Dates");
    const values = restoredSheet.getRange("A1:B1").values[0]!;
    expect(values[0]).toBeInstanceOf(Date);
    expect((values[0] as Date).toISOString()).toBe("2026-08-09T12:34:56.789Z");
    expect(values[1]).toBeInstanceOf(Date);
    expect((values[1] as Date).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(restoredSheet.getRange("B1").formulas).toEqual([["=DATE(2024,2,29)"]]);
    disposeArtifact(source);
    disposeArtifact(restored);
  });

  test("projects the complete document API through a real document session", () => {
    const document = Document.create({
      idNamespace: "0011223344556677",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    document.blocks.addHeading("Native document", 1);
    const paragraph = document.blocks.addParagraph([
      new DocumentTextRun("Exact ", { bold: true }),
      new DocumentTextRun("projection"),
    ]);
    paragraph.replace("projection", "kernel projection");
    document.comments.setSelf({ displayName: "Reviewer" });
    document.comments.addThread({ block: paragraph, start: 0, end: 5 }, "Verified");
    const diagnostics = getArtifactCompositeDiagnostics(document);
    expect(diagnostics.modality).toBe("document");
    expect(diagnostics.nativeRevision).toBeGreaterThan(0n);
    expect((diagnostics.hostProjection as { blocks: unknown[] }).blocks).toHaveLength(2);
  });

  test("imports and exports non-default first-page geometry through native authority", async () => {
    const source = ReferenceDocument.create({
      idNamespace: "8899aabbccddeeff",
      page: {
        widthPt: 792,
        heightPt: 612,
        marginTopPt: 54,
        marginRightPt: 48,
        marginBottomPt: 42,
        marginLeftPt: 36,
        headerPt: 27.5,
        footerPt: 31.25,
        gutterPt: 9.5,
      },
    });
    source.blocks.addParagraph("Landscape source");
    const docx = await ReferenceDocumentFile.exportDocx(source);
    const restored = await DocumentFile.importDocx(docx);
    expect(restored.page).toMatchObject({
      widthPt: 792,
      heightPt: 612,
      marginTopPt: 54,
      marginRightPt: 48,
      marginBottomPt: 42,
      marginLeftPt: 36,
      headerPt: 27.5,
      footerPt: 31.25,
      gutterPt: 9.5,
    });
    const diagnostics = getArtifactCompositeDiagnostics(restored);
    expect(diagnostics.modality).toBe("document");
    expect(diagnostics.nativeRevision).toBeGreaterThan(0n);

    const reexported = await DocumentFile.exportDocx(restored);
    const roundTripped = await ReferenceDocumentFile.importDocx(reexported);
    expect(roundTripped.page).toMatchObject(restored.page);

    const sharedPage = {
      widthPt: 792,
      heightPt: 612,
      marginTopPt: 54,
      marginRightPt: 48,
      marginBottomPt: 42,
      marginLeftPt: 36,
    } as const;
    const defaultEdges = Document.create({
      idNamespace: "1021324354657687",
      page: sharedPage,
    });
    const customEdges = Document.create({
      idNamespace: "1021324354657687",
      page: { ...sharedPage, headerPt: 27.5, footerPt: 31.25, gutterPt: 9.5 },
    });
    const defaultDiagnostics = getArtifactCompositeDiagnostics(defaultEdges);
    const customDiagnostics = getArtifactCompositeDiagnostics(customEdges);
    expect(defaultDiagnostics.nativeStateHash).not.toBe(customDiagnostics.nativeStateHash);
    expect(
      new DataView(
        defaultDiagnostics.nativeSnapshot.buffer,
        defaultDiagnostics.nativeSnapshot.byteOffset,
        defaultDiagnostics.nativeSnapshot.byteLength,
      ).getUint16(10, true),
    ).toBe(0);
    expect(
      new DataView(
        customDiagnostics.nativeSnapshot.buffer,
        customDiagnostics.nativeSnapshot.byteOffset,
        customDiagnostics.nativeSnapshot.byteLength,
      ).getUint16(10, true),
    ).toBe(1);
    const reopened = NativeDocumentSession.open(
      productionTestRuntime(),
      customDiagnostics.nativeSnapshot,
    );
    expect(reopened.stateHash()).toBe(customDiagnostics.nativeStateHash);
    expect(reopened.snapshot()).toEqual(customDiagnostics.nativeSnapshot);
    reopened.dispose();
    disposeArtifact(defaultEdges);
    disposeArtifact(customEdges);
  });

  test("keeps presentation object identity while native reconciliation changes", () => {
    const presentation = Presentation.create();
    const slide = presentation.slides.add();
    const shape = slide.shapes.add({
      geometry: "textbox",
      name: "title",
      position: { left: 40, top: 40, width: 600, height: 120 },
    });
    shape.text = "Native presentation";
    expect(presentation.resolve(shape.id)).toBe(shape);
    slide.background.fill = "#f8fafc";
    expect(presentation.resolve(shape.id)).toBe(shape);
    const before = getArtifactCompositeDiagnostics(presentation).nativeStateHash;
    shape.text.replace("presentation", "deck");
    const after = getArtifactCompositeDiagnostics(presentation).nativeStateHash;
    expect(after).not.toBe(before);
    expect(shape.text.toString()).toBe("Native deck");
  });

  test("imports, queries, snapshots, and exports custom slide size through native authority", async () => {
    const source = ReferencePresentation.create({ slideSize: { width: 960, height: 540 } });
    const sourceSlide = source.slides.add();
    sourceSlide.shapes.add({
      geometry: "textbox",
      name: "Custom size",
      text: "Native custom size",
      position: { left: 40, top: 40, width: 400, height: 80 },
    });
    const pptx = await ReferencePresentationFile.exportPptx(source);
    const restored = await PresentationFile.importPptx(pptx);
    expect(restored.slideSize).toEqual({ width: 960, height: 540 });

    const diagnostics = getArtifactCompositeDiagnostics(restored);
    expect((diagnostics.hostProjection as { slideSize: unknown }).slideSize).toEqual({
      width: 960,
      height: 540,
    });
    const reopened = NativePresentationSession.open(
      productionTestRuntime(),
      diagnostics.nativeSnapshot,
    );
    expect(reopened.snapshot()).toEqual(diagnostics.nativeSnapshot);
    expect(reopened.stateHash()).toBe(diagnostics.nativeStateHash);
    const metadata = decodePresentationArtifactQueryResponse(
      reopened.query(
        encodePresentationArtifactQuery({
          kind: "metadata",
          maxBytes: 1_024,
        }),
      ),
    );
    expect(metadata).toMatchObject({
      kind: "metadata",
      slideSize: { width: 9_144_000, height: 5_143_500 },
    });

    const reexported = await PresentationFile.exportPptx(restored);
    const roundTripped = await ReferencePresentationFile.importPptx(reexported);
    expect(roundTripped.slideSize).toEqual({ width: 960, height: 540 });

    const hostile = ReferencePresentation.create();
    hostile.slideSize.width = Number.MAX_VALUE;
    expect(() => encodePresentationProjectionCommands(hostile, 1n)).toThrow(
      "presentation slide width exceeds the native presentation-coordinate bound",
    );
    reopened.dispose();
    disposeArtifact(restored);
  });

  test("projects template scenes and immutable raster references into native authority", () => {
    const presentation = Presentation.create();
    const master = presentation.masters.add({
      name: "Brand",
      elements: [
        {
          kind: "shape",
          config: {
            geometry: "textbox",
            name: "Master title",
            text: "OpenGeni",
            position: { left: 40, top: 20, width: 300, height: 48 },
          },
        },
        {
          kind: "image",
          config: {
            name: "Master mark",
            dataUrl: ONE_PIXEL_PNG,
            alt: "Brand mark",
            position: { left: 1_180, top: 20, width: 40, height: 40 },
          },
        },
      ],
    });
    const layout = presentation.layouts.add({
      name: "Title and content",
      masterId: master.id,
      elements: [
        {
          kind: "table",
          config: {
            name: "Layout table",
            rows: [["Template"]],
            position: { left: 80, top: 160, width: 500, height: 100 },
          },
        },
      ],
    });
    const slide = presentation.slides.add();
    slide.setLayout(layout);
    const image = slide.images.add({
      dataUrl: ONE_PIXEL_PNG,
      alt: "Native raster",
      fit: "cover",
    });

    const diagnostics = getArtifactCompositeDiagnostics(presentation);
    expect(diagnostics.nativeRevision).toBeGreaterThan(0n);
    expect(diagnostics.nativeStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(presentation.resolve(image.id)).toBe(image);
  });

  test("real native sessions reject corrupt snapshots and close deterministically", () => {
    const runtime = productionTestRuntime();
    expect(() => NativeDocumentSession.open(runtime, new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => NativePresentationSession.open(runtime, new Uint8Array([1, 2, 3]))).toThrow();
    const session = NativeDocumentSession.create(runtime, 44n);
    session.dispose();
    session.dispose();
    expect(session.isClosed()).toBe(true);
    expect(() => session.snapshot()).toThrow("closed");
  });

  test("retains native sessions and advances every hot facade revision", () => {
    const workbook = Workbook.create();
    const workbookState = requireCompositeState(workbook, "spreadsheet");
    const workbookSession = workbookState.native;
    const sheet = workbook.worksheets.add("Hot path");
    const sheetRevision = workbookState.native.revision();
    sheet.getRange("A1").values = [[42]];
    expect(workbookState.native).toBe(workbookSession);
    expect(workbookState.native.revision()).toBe(sheetRevision + 1n);
    expect(workbook.revision).toBe(Number(workbookState.native.revision()));

    const document = Document.create();
    const documentState = requireCompositeState(document, "document");
    const documentSession = documentState.native;
    document.blocks.addParagraph("First");
    const paragraphRevision = documentState.native.revision();
    document.blocks.addParagraph("Second");
    expect(documentState.native).toBe(documentSession);
    expect(documentState.native.revision()).toBe(paragraphRevision + 1n);
    expect(document.revision).toBe(Number(documentState.native.revision()));

    const presentation = Presentation.create();
    const presentationState = requireCompositeState(presentation, "presentation");
    const presentationSession = presentationState.native;
    presentation.slides.add();
    const slideRevision = presentationState.native.revision();
    presentation.slides.add();
    expect(presentationState.native).toBe(presentationSession);
    expect(presentationState.native.revision()).toBe(slideRevision + 1n);
  });

  test("keeps large hot mutations within production-native latency budgets", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("20k cells");
    sheet.getRangeByIndexes(0, 0, 200, 100).values = Array.from({ length: 200 }, (_rowValue, row) =>
      Array.from({ length: 100 }, (_columnValue, column) => row * 100 + column),
    );
    for (let index = 0; index < 5; index += 1) {
      sheet.getCell(index, index).values = [[-index - 1]];
    }
    const cellEditMs: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const started = performance.now();
      sheet.getCell(index, index).values = [[-index - 100]];
      cellEditMs.push(performance.now() - started);
    }
    cellEditMs.sort((left, right) => left - right);
    const cellEditP95Ms = cellEditMs[Math.ceil(cellEditMs.length * 0.95) - 1]!;

    const document = Document.create();
    const documentStarted = performance.now();
    for (let index = 0; index < 500; index += 1) {
      document.blocks.addParagraph(`Paragraph ${index}`);
    }
    const documentMs = performance.now() - documentStarted;

    const presentation = Presentation.create();
    const presentationStarted = performance.now();
    for (let index = 0; index < 200; index += 1) {
      presentation.slides.add();
    }
    const presentationMs = performance.now() - presentationStarted;

    expect(cellEditP95Ms).toBeLessThan(25);
    expect(documentMs).toBeLessThan(250);
    expect(presentationMs).toBeLessThan(250);
    expect(document.revision).toBe(500);
    expect(getArtifactCompositeDiagnostics(presentation).nativeRevision).toBe(200n);
  }, 5_000);

  test("batches 1,000 sequential public edits into one atomic native reconciliation", () => {
    const workbook = Workbook.create();
    const workbookStarted = performance.now();
    workbook.batch((draft) => {
      const sheet = draft.worksheets.add("Batch");
      for (let row = 0; row < 1_000; row += 1) {
        sheet.getCell(row, 0).values = [[row]];
      }
    });
    const workbookMs = performance.now() - workbookStarted;
    expect(workbook.worksheets.getItem("Batch").getCell(999, 0).values).toEqual([[999]]);

    const document = Document.create({ idNamespace: "1234567890abcdef" });
    const documentStarted = performance.now();
    document.batch((draft) => {
      for (let index = 0; index < 1_000; index += 1) {
        draft.blocks.addParagraph(`Paragraph ${index}`);
      }
    });
    const documentMs = performance.now() - documentStarted;
    expect(document.blocks.items).toHaveLength(1_000);

    const presentation = Presentation.create();
    const presentationStarted = performance.now();
    presentation.batch((draft) => {
      const slide = draft.slides.add();
      for (let index = 0; index < 1_000; index += 1) {
        slide.shapes.add({
          geometry: "rect",
          name: `Shape ${index}`,
          position: {
            left: index % 100,
            top: index % 50,
            width: 10,
            height: 10,
          },
        });
      }
    });
    const presentationMs = performance.now() - presentationStarted;
    expect(presentation.slides.items[0]!.shapes.items).toHaveLength(1_000);
    expect({ workbookMs, documentMs, presentationMs }).toEqual({
      workbookMs: expect.any(Number),
      documentMs: expect.any(Number),
      presentationMs: expect.any(Number),
    });
    expect(Math.max(workbookMs, documentMs, presentationMs)).toBeLessThan(5_000);
  }, 30_000);
});

function normalizeCellDates(values: readonly (readonly unknown[])[]): unknown[][] {
  return values.map((row) =>
    row.map((value) => (value instanceof Date ? Date.prototype.toISOString.call(value) : value)),
  );
}
