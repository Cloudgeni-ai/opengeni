import { describe, expect, test } from "bun:test";
import { Document, DocumentFile, DocumentTextRun, type SerializedDocument } from "../src/document";
import { ArtifactLimitError, UnsupportedArtifactFeatureError } from "../src/errors";
import {
  DocxExportCompatibilityError,
  packDocxWithBoundedCompression,
} from "../src/document-docx-packer";
import {
  DocumentFidelityError,
  attachLossPreservationEnvelope,
  exportDocx,
  fidelityReport,
  importDocx,
  lossPreservationEnvelope,
} from "../src/document-docx-codec";

const deterministicOptions = {
  idNamespace: "0011223344556677",
  now: () => new Date("2026-01-02T03:04:05.000Z"),
} as const;

describe("document reference model", () => {
  test("creates, inspects, deterministically serializes, and preserves stable structural IDs", async () => {
    const document = Document.create(deterministicOptions);
    document.blocks.addHeading("Quarterly review", 1);
    document.blocks.addParagraph([
      new DocumentTextRun("Revenue "),
      new DocumentTextRun("grew", { bold: true, color: "#2563EB" }),
      new DocumentTextRun(" year over year."),
    ]);
    document.blocks.addTable(
      [
        ["Metric", "Value"],
        ["Revenue", "$120"],
      ],
      { widthPt: 300, headerRows: 1, columnWidthsPt: [180, 120] },
    );

    const inspect = await document.inspect({ kind: "document,paragraph,table,section" });
    expect(inspect.ndjson).toContain("Quarterly review");
    expect(inspect.ndjson).toContain("Revenue");

    const first = JSON.stringify(document.toJSON());
    const second = JSON.stringify(document.toJSON());
    expect(second).toBe(first);
    const restored = Document.fromJSON(JSON.parse(first) as SerializedDocument);
    expect(JSON.stringify(restored.toJSON())).toBe(first);
    expect(restored.blocks.items.map((block) => block.id)).toEqual(
      document.blocks.items.map((block) => block.id),
    );
    expect((await restored.render({ format: "svg" })).type).toBe("image/svg+xml");

    const autoModes = Document.fromJSON(Document.create(deterministicOptions).toJSON());
    autoModes.sections.items[0]!.headers.first.addParagraph("First");
    autoModes.sections.items[0]!.headers.even.addParagraph("Even");
    const tracked = autoModes.blocks.addParagraph("Tracked");
    autoModes.changes.add({ block: tracked, start: 0, end: tracked.text.length }, "insert");
    expect(autoModes.sections.items[0]?.titlePage).toBe(true);
    expect(autoModes.evenAndOddHeaders).toBe(true);
    expect(autoModes.trackRevisions).toBe(true);
  });

  test("round-trips editable sections, headers, footers, real lists, and fixed-geometry tables", async () => {
    const document = Document.create(deterministicOptions);
    document.sections.items[0]!.headers.default.addParagraph("Acme confidential");
    document.sections.items[0]!.footers.default.addParagraph("Page footer");
    document.blocks.addHeading("Plan", 1);
    document.blocks.addParagraph("First", { list: { kind: "number", level: 0 } });
    document.blocks.addParagraph("Second", { list: { kind: "number", level: 0 } });
    document.blocks.addTable(
      [
        ["Owner", "Status"],
        ["Ada", "Ready"],
      ],
      {
        widthPt: 360,
        columnWidthsPt: [240, 120],
        headerRows: 1,
        headerFill: "#E5E7EB",
        borderColor: "#64748B",
        cellPaddingPt: 7,
        allowRowSplit: true,
      },
    );
    const secondSection = document.sections.add({
      page: {
        widthPt: 792,
        heightPt: 612,
        marginLeftPt: 54,
        marginRightPt: 54,
        headerPt: 27.5,
        footerPt: 31.25,
        gutterPt: 9.5,
      },
    });
    secondSection.headers.first.addParagraph("Landscape appendix");
    document.blocks.addParagraph("Appendix body");

    const bytes = await DocumentFile.exportDocx(document);
    expect(bytes.size).toBeGreaterThan(5_000);
    const restored = await DocumentFile.importDocx(bytes);
    expect(restored.sections.items).toHaveLength(2);
    expect(restored.sections.items[0]!.headers.default.items[0]).toMatchObject({
      text: "Acme confidential",
    });
    expect(restored.sections.items[0]!.footers.default.items[0]).toMatchObject({
      text: "Page footer",
    });
    expect(restored.sections.items[1]!.headers.first.items[0]).toMatchObject({
      text: "Landscape appendix",
    });
    expect(restored.sections.items[1]!.page.widthPt).toBe(792);
    expect(restored.sections.items[1]!.page).toMatchObject({
      headerPt: 27.5,
      footerPt: 31.25,
      gutterPt: 9.5,
    });
    const restoredTable = restored.blocks.items.find((block) => block.kind === "table");
    expect(restoredTable?.style).toMatchObject({
      widthPt: 360,
      columnWidthsPt: [240, 120],
      headerRows: 1,
      headerFill: "#E5E7EB",
      borderColor: "#64748B",
      cellPaddingPt: 7,
      allowRowSplit: true,
    });
    expect(await restored.inspect({ kind: "paragraph,table" })).toMatchObject({ truncated: false });
  });

  test("round-trips threaded comments, resolution, and tracked insertions/deletions", async () => {
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph("Review inserted and deleted text.");
    document.comments.setSelf({ displayName: "Ada Lovelace" });
    const comment = document.comments.addThread(
      { block: paragraph, start: 0, end: 6 },
      "Please verify.",
    );
    comment.addReply("Verified.", "Grace Hopper");
    comment.resolve();
    document.changes.add({ block: paragraph, start: 7, end: 15 }, "insert", "Ada Lovelace");
    document.changes.add({ block: paragraph, start: 20, end: 27 }, "delete", "Grace Hopper");

    const restored = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
    expect(restored.comments.items).toHaveLength(1);
    const restoredComment = restored.comments.items[0]!;
    expect({
      start: restoredComment.start,
      end: restoredComment.end,
      resolved: restoredComment.resolved,
      replies: restoredComment.replies.map(({ author, text }) => ({ author, text })),
    }).toEqual({
      start: 0,
      end: 6,
      resolved: true,
      replies: [
        { author: "Ada Lovelace", text: "Please verify." },
        { author: "Grace Hopper", text: "Verified." },
      ],
    });
    expect(
      restored.changes.items.map((change) => ({
        kind: change.kind,
        start: change.start,
        end: change.end,
      })),
    ).toEqual([
      { kind: "insert", start: 7, end: 15 },
      { kind: "delete", start: 20, end: 27 },
    ]);

    const sameBytes = await DocumentFile.exportDocx(document);
    const firstImport = await DocumentFile.importDocx(sameBytes);
    const secondImport = await DocumentFile.importDocx(sameBytes);
    expect(firstImport.idNamespace).toBe(secondImport.idNamespace);
    expect(firstImport.blocks.items.map((block) => block.id)).toEqual(
      secondImport.blocks.items.map((block) => block.id),
    );

    await Bun.sleep(5);
    const independentlyPacked = await DocumentFile.importDocx(
      await DocumentFile.exportDocx(document),
    );
    expect(independentlyPacked.idNamespace).toBe(firstImport.idNamespace);
    expect(independentlyPacked.blocks.items.map((block) => block.id)).toEqual(
      firstImport.blocks.items.map((block) => block.id),
    );
  });

  test("round-trips tabs and soft line breaks through every supported DOCX text story", async () => {
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph("Body\tcolumn\nnext line");
    const changedParagraph = document.blocks.addParagraph("Changed\tcolumn\nnext line");
    document.blocks.addTable([["Cell\tvalue\nnext line"]], {
      widthPt: 180,
      columnWidthsPt: [180],
    });
    const comment = document.comments.addThread(
      { block: paragraph, start: 0, end: 4 },
      "Root\tnote\nnext line",
    );
    comment.addReply("Reply\ttab\nnext line", "Reviewer");
    document.changes.add(
      { block: changedParagraph, start: 0, end: changedParagraph.text.length },
      "insert",
    );

    const restored = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
    expect(restored.blocks.items[0]).toMatchObject({ text: "Body\tcolumn\nnext line" });
    expect(restored.blocks.items[1]).toMatchObject({ text: "Changed\tcolumn\nnext line" });
    expect(restored.blocks.items[2]).toMatchObject({
      rows: [[[expect.objectContaining({ text: "Cell\tvalue\nnext line" })]]],
    });
    expect(restored.comments.items[0]?.replies.map((reply) => reply.text)).toEqual([
      "Root\tnote\nnext line",
      "Reply\ttab\nnext line",
    ]);
  });

  test("canonicalizes empty paragraphs and preserves styled insertion-point runs", async () => {
    const document = Document.create(deterministicOptions);
    const canonicalEmpty = document.blocks.addParagraph([]);
    const styledEmpty = document.blocks.addParagraph([
      new DocumentTextRun("", { bold: true, fontFamily: "Arial", color: "#2563EB" }),
    ]);
    document.comments.addThread({ block: styledEmpty, start: 0, end: 0 }, "Insertion point");
    expect(canonicalEmpty.runs).toHaveLength(1);
    expect(canonicalEmpty.runs[0]).toMatchObject({ text: "", style: {} });

    const restored = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
    const restoredEmpty = restored.blocks.items[0];
    const restoredStyled = restored.blocks.items[1];
    if (restoredEmpty?.kind !== "paragraph" || restoredStyled?.kind !== "paragraph") {
      throw new Error("Empty paragraph fixtures did not round-trip as paragraphs");
    }
    expect(restoredEmpty.runs.map((run) => run.serialize())).toEqual([{ text: "", style: {} }]);
    expect(restoredStyled.runs.map((run) => run.serialize())).toEqual([
      {
        text: "",
        style: { bold: true, fontFamily: "Arial", color: "#2563EB" },
      },
    ]);
    expect(restoredStyled.text).toBe(styledEmpty.text);
    expect(restored.comments.items[0]).toMatchObject({
      blockId: restoredStyled.id,
      start: 0,
      end: 0,
    });
  });

  test("exports highly repetitive canonical text within the importer compression policy", async () => {
    const document = Document.create(deterministicOptions);
    const text = "a".repeat(1_000_000);
    document.blocks.addParagraph(text);

    const exported = await DocumentFile.exportDocx(document);
    const restored = await DocumentFile.importDocx(exported);
    expect(restored.blocks.items[0]).toMatchObject({ kind: "paragraph", text });
  });

  test("emits byte-deterministic DOCX packages", async () => {
    const document = Document.create(deterministicOptions);
    document.blocks.addParagraph("Deterministic package");
    const first = new Uint8Array(await (await exportDocx(document)).arrayBuffer());
    await Bun.sleep(5);
    const second = new Uint8Array(await (await exportDocx(document)).arrayBuffer());
    expect(second).toEqual(first);
  });

  test("fails closed if the pinned DOCX compiler adapter drifts", async () => {
    await expect(packDocxWithBoundedCompression({}, {})).rejects.toBeInstanceOf(
      DocxExportCompatibilityError,
    );
    await expect(
      packDocxWithBoundedCompression(
        {},
        {
          compiler: { compile: () => ({}) },
        },
      ),
    ).rejects.toMatchObject({
      name: "DocxExportCompatibilityError",
      code: "incompatible_docx_runtime",
    });

    let fixedDate: Date | undefined;
    let compileOverrides: unknown;
    const bytes = await packDocxWithBoundedCompression(
      {},
      {
        compiler: {
          compile: (_file: unknown, _prettify: unknown, overrides: unknown) => {
            compileOverrides = overrides;
            return {
              forEach(callback: (path: string, entry: { date: Date }) => void) {
                const entry = { date: new Date() };
                callback("word/document.xml", entry);
                fixedDate = entry.date;
              },
              async generateAsync() {
                return new Uint8Array([0x50, 0x4b]);
              },
            };
          },
        },
      },
      [{ path: "docProps/core.xml", data: "<fixed/>" }],
    );
    expect(bytes).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(compileOverrides).toEqual([{ path: "docProps/core.xml", data: "<fixed/>" }]);
    expect(fixedDate).toEqual(new Date(1980, 0, 1, 0, 0, 0, 0));
  });

  test("preserves bounded inert OOXML exactly until an edit explicitly discards it", async () => {
    const source = Document.create(deterministicOptions);
    source.blocks.addParagraph("Editable body");
    const plain = new Uint8Array(await (await exportDocx(source)).arrayBuffer());
    const withCustomXml = await addSafeCustomXml(plain);

    const imported = await importDocx(ownedArrayBuffer(withCustomXml));
    expect(fidelityReport(imported)).toEqual([
      expect.objectContaining({
        code: "content-preserved-in-source",
        severity: "warning",
        parts: expect.arrayContaining(["customXml/item1.xml", "customXml/itemProps1.xml"]),
      }),
    ]);
    expect([...new Uint8Array(await (await exportDocx(imported)).arrayBuffer())]).toEqual([
      ...withCustomXml,
    ]);
    await expect(
      importDocx(ownedArrayBuffer(withCustomXml), {
        unsupportedContent: "error",
      }),
    ).rejects.toBeInstanceOf(DocumentFidelityError);

    const envelope = lossPreservationEnvelope(imported);
    expect(envelope).not.toBeNull();
    const restored = Document.fromJSON(imported.toJSON());
    await attachLossPreservationEnvelope(restored, envelope!);
    expect([...new Uint8Array(await (await exportDocx(restored)).arrayBuffer())]).toEqual([
      ...withCustomXml,
    ]);

    const unrelated = Document.create(deterministicOptions);
    unrelated.blocks.addParagraph("Different body");
    await expect(attachLossPreservationEnvelope(unrelated, envelope!)).rejects.toMatchObject({
      name: "DocxImportError",
      code: "invalid_package",
    });

    let getterReads = 0;
    const hostileEnvelope = { ...envelope! };
    Object.defineProperty(hostileEnvelope, "opaqueContent", {
      enumerable: true,
      get() {
        getterReads += 1;
        return envelope!.opaqueContent;
      },
    });
    await expect(attachLossPreservationEnvelope(restored, hostileEnvelope)).rejects.toThrow(
      /data properties/i,
    );
    expect(getterReads).toBe(0);

    const paragraph = imported.blocks.items[0];
    if (paragraph?.kind !== "paragraph") throw new Error("Custom XML fixture body is missing");
    paragraph.append(" changed");
    expect(fidelityReport(imported)[0]).toMatchObject({
      code: "content-will-be-discarded",
      severity: "error",
    });
    await expect(exportDocx(imported)).rejects.toBeInstanceOf(DocumentFidelityError);
    const discarded = new Uint8Array(
      await (
        await exportDocx(imported, {
          unsupportedContent: "discard",
        })
      ).arrayBuffer(),
    );
    const discardedZip = await (await import("jszip")).default.loadAsync(discarded);
    expect(discardedZip.file("customXml/item1.xml")).toBeNull();
    expect((await importDocx(ownedArrayBuffer(discarded))).blocks.items[0]).toMatchObject({
      kind: "paragraph",
      text: "Editable body changed",
    });
  });

  test("quantizes DOCX table geometry as one exact fixed grid", async () => {
    const document = Document.create(deterministicOptions);
    document.blocks.addTable([["A", "B", "C"]], {
      widthPt: 30.072,
      columnWidthsPt: [10.024, 10.024, 10.024],
      cellPaddingPt: 1,
    });

    const restored = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
    const table = restored.blocks.items[0];
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") throw new Error("Fixture table missing");
    expect(table.style.columnWidthsPt).toEqual([10, 10, 10]);
    expect(table.style.widthPt).toBe(30);
  });

  test("atomically edits and formats ranges while preserving styles and rebasing review anchors", () => {
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph([
      new DocumentTextRun("Hello", { bold: true, color: "#2563EB" }),
      new DocumentTextRun(" styled world", { italic: true }),
    ]);
    const comment = document.comments.addThread({ block: paragraph, start: 6, end: 12 }, "Style");
    const change = document.changes.add({ block: paragraph, start: 13, end: 18 }, "insert");
    const beforeRevision = document.revision;

    paragraph.edit({ start: 0, end: 5, text: "Hi" });
    expect(document.revision).toBe(beforeRevision + 1);
    expect(paragraph.text).toBe("Hi styled world");
    expect(paragraph.runs[0]).toMatchObject({
      text: "Hi",
      style: { bold: true, color: "#2563EB" },
    });
    expect(comment).toMatchObject({ start: 3, end: 9 });
    expect(change).toMatchObject({ start: 10, end: 15 });

    const formatRevision = document.revision;
    paragraph.format({ start: 3, end: 15, style: { underline: true } });
    expect(document.revision).toBe(formatRevision + 1);
    expect(paragraph.runs.some((run) => run.style.italic && run.style.underline)).toBe(true);
    expect(
      paragraph.runs
        .filter((run) => run.style.underline)
        .map((run) => run.text)
        .join(""),
    ).toBe(paragraph.text.slice(3, 15));

    const unicode = document.blocks.addParagraph("A😀B");
    expect(() =>
      document.comments.addThread({ block: unicode, start: 2, end: 3 }, "broken"),
    ).toThrow("surrogate pair");
    expect(() => unicode.edit({ start: 2, end: 2, text: "x" })).toThrow("surrogate pair");
    unicode.edit({ start: 1, end: 3, text: "🙂" });
    expect(unicode.text).toBe("A🙂B");

    const repeated = document.blocks.addParagraph("abc MIDDLE abc");
    const middle = document.comments.addThread({ block: repeated, start: 4, end: 10 }, "Keep");
    const replaceRevision = document.revision;
    repeated.replace(/abc/g, "z");
    expect(repeated.text).toBe("z MIDDLE z");
    expect(middle).toMatchObject({ start: 2, end: 8 });
    expect(document.revision).toBe(replaceRevision + 1);

    const pointParagraph = document.blocks.addParagraph("abcd");
    const point = document.comments.addThread({ block: pointParagraph, start: 2, end: 2 }, "Caret");
    pointParagraph.edit({ start: 1, end: 3, text: "XYZ" });
    expect(point).toMatchObject({ start: 1, end: 1 });

    const nearLimit = Document.create(deterministicOptions);
    const nearLimitParagraph = nearLimit.blocks.addParagraph(
      `${"x".repeat(9_999_985)}${"a".repeat(10)}`,
    );
    const beforeText = nearLimitParagraph.text;
    const beforeLimitRevision = nearLimit.revision;
    expect(() => nearLimitParagraph.replace(/a/g, "aa")).toThrow("exceeds");
    expect(nearLimitParagraph.text).toBe(beforeText);
    expect(nearLimit.revision).toBe(beforeLimitRevision);
  });

  test("repeated multi-section DOCX round-trips do not synthesize blank body paragraphs", async () => {
    let document = Document.create(deterministicOptions);
    document.blocks.addParagraph("A");
    document.sections.add({ page: { widthPt: 792, heightPt: 612 } });
    document.blocks.addParagraph("B");
    for (let cycle = 0; cycle < 3; cycle++) {
      document = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
      expect(
        document.blocks.items.map((block) =>
          block.kind === "paragraph" ? block.text : block.kind,
        ),
      ).toEqual(["A", "B"]);
      expect(document.sections.items).toHaveLength(2);
    }
  });

  test("keeps intentionally empty later-section stories from inheriting earlier headers", async () => {
    let document = Document.create(deterministicOptions);
    document.sections.items[0]!.headers.default.addParagraph("First section only");
    document.sections.items[0]!.headers.first.addParagraph("First page only");
    document.blocks.addParagraph("A");
    document.sections.add();
    document.blocks.addParagraph("B");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      document = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
      expect(document.sections.items[0]!.headers.default.items[0]).toMatchObject({
        text: "First section only",
      });
      expect(document.sections.items[1]!.headers.default.items).toHaveLength(0);
      expect(document.sections.items[1]!.headers.first.items).toHaveLength(0);
    }
  });

  test("preserves active empty first-page and even-page stories", async () => {
    let document = Document.create({
      ...deterministicOptions,
      titlePage: true,
      evenAndOddHeaders: true,
    });
    document.sections.items[0]!.headers.default.addParagraph("Default pages");
    document.blocks.addParagraph("Body");

    for (let cycle = 0; cycle < 2; cycle += 1) {
      document = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
      expect(document.sections.items[0]?.titlePage).toBe(true);
      expect(document.evenAndOddHeaders).toBe(true);
      expect(document.sections.items[0]?.headers.default.items[0]).toMatchObject({
        text: "Default pages",
      });
      expect(document.sections.items[0]?.headers.first.items).toHaveLength(0);
      expect(document.sections.items[0]?.headers.even.items).toHaveLength(0);
    }
  });

  test("preserves dormant first-page/even-page stories and revision-tracking mode", async () => {
    let document = Document.create({
      ...deterministicOptions,
      titlePage: false,
      evenAndOddHeaders: false,
      trackRevisions: true,
    });
    const section = document.sections.items[0]!;
    section.headers.default.addParagraph("Default");
    section.headers.first.addParagraph("Dormant first");
    section.headers.even.addParagraph("Dormant even");
    document.blocks.addParagraph("Body");

    document = await DocumentFile.importDocx(await DocumentFile.exportDocx(document));
    expect(document.sections.items[0]?.titlePage).toBe(false);
    expect(document.evenAndOddHeaders).toBe(false);
    expect(document.trackRevisions).toBe(true);
    expect(document.sections.items[0]?.headers.first.items[0]).toMatchObject({
      text: "Dormant first",
    });
    expect(document.sections.items[0]?.headers.even.items[0]).toMatchObject({
      text: "Dormant even",
    });

    const trackedOff = Document.create({ ...deterministicOptions, trackRevisions: false });
    const paragraph = trackedOff.blocks.addParagraph("Tracked content");
    trackedOff.changes.add({ block: paragraph, start: 0, end: 7 }, "insert");
    const restoredTrackedOff = await DocumentFile.importDocx(
      await DocumentFile.exportDocx(trackedOff),
    );
    expect(restoredTrackedOff.changes.items).toHaveLength(1);
    expect(restoredTrackedOff.trackRevisions).toBe(false);
  });

  test("projects explicit pages with the effective first, even, and default stories", async () => {
    const document = Document.create({
      ...deterministicOptions,
      titlePage: true,
      evenAndOddHeaders: true,
    });
    const section = document.sections.items[0]!;
    section.headers.default.addParagraph("Default header");
    section.headers.first.addParagraph("First header");
    section.headers.even.addParagraph("Even header");
    section.footers.default.addParagraph("Default footer");
    section.footers.first.addParagraph("First footer");
    section.footers.even.addParagraph("Even footer");
    document.blocks.addParagraph("Page one");
    document.blocks.addPageBreak();
    document.blocks.addParagraph("Page two");
    document.blocks.addParagraph("Page three", { pageBreakBefore: true });

    const html = await (await document.render({ format: "html" })).text();
    const svg = await (await document.render({ format: "svg" })).text();
    for (const projection of [html, svg]) {
      expect(projection).toContain('data-page-number="1"');
      expect(projection).toContain('data-page-number="2"');
      expect(projection).toContain('data-page-number="3"');
      expect(projection).toContain('data-story-variant="first"');
      expect(projection).toContain('data-story-variant="even"');
      expect(projection).toContain('data-story-variant="default"');
      for (const text of [
        "First header",
        "First footer",
        "Even header",
        "Even footer",
        "Default header",
        "Default footer",
        "Page one",
        "Page two",
        "Page three",
      ])
        expect(projection).toContain(text);
    }
    expect(html.match(/<section\b/g) ?? []).toHaveLength(3);
  });

  test("keeps internal mutation capabilities unforgeable and collection views read-only", () => {
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph("Safe");
    const thread = document.comments.addThread(
      { block: paragraph, start: 0, end: paragraph.text.length },
      "Review",
    );
    const before = JSON.stringify(document.toJSON());

    expect(() =>
      (document.blocks.items as unknown as { push(value: unknown): void }).push(paragraph),
    ).toThrow("read-only");
    expect(() => (paragraph.runs as unknown as DocumentTextRun[]).splice(0, 1)).toThrow(
      "read-only",
    );
    expect(() =>
      (
        thread.replies as unknown as Array<{ author: string; text: string; createdAt: string }>
      ).pop(),
    ).toThrow("read-only");
    expect(() =>
      (document as unknown as { changed(access: symbol): void }).changed(Symbol("forged")),
    ).toThrow("not part of the public mutation API");
    expect(() =>
      (
        thread as unknown as {
          appendImportedReply(
            reply: { author: string; text: string; createdAt: string },
            access: symbol,
          ): void;
        }
      ).appendImportedReply(
        { author: "Attacker", text: "forged", createdAt: "2026-01-02T03:04:05.000Z" },
        Symbol("forged"),
      ),
    ).toThrow("not part of the public mutation API");

    expect(JSON.stringify(document.toJSON())).toBe(before);
  });

  test("fails closed for reviewed inherited headers that cannot retain shared identity", async () => {
    const docx = await import("docx");
    const sharedHeader = new docx.Header({
      children: [
        new docx.Paragraph({
          children: [
            new docx.CommentRangeStart(0),
            new docx.TextRun("Shared"),
            new docx.CommentRangeEnd(0),
            new docx.CommentReference(0),
          ],
        }),
      ],
    });
    const source = new docx.Document({
      comments: {
        children: [
          {
            id: 0,
            author: "Reviewer",
            date: new Date("2026-01-02T03:04:05.000Z"),
            children: [new docx.Paragraph("Header review")],
          },
        ],
      },
      sections: [
        { headers: { default: sharedHeader }, children: [new docx.Paragraph("One")] },
        { children: [new docx.Paragraph("Two")] },
      ],
    });

    await expect(DocumentFile.importDocx(await docx.Packer.toBlob(source))).rejects.toMatchObject({
      name: "UnsupportedArtifactFeatureError",
      feature: "linked or inherited header/footer stories",
    });
  });

  test("escapes text and fails closed on unsafe CSS, colors, and render parameters", async () => {
    const attack = '<script data-x="1">alert(1)</script>&';
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph(attack);
    document.blocks.addParagraph("A\tB\nC");
    document.blocks.addTable([["Cell"]], {
      widthPt: 144,
      columnWidthsPt: [144],
      cellPaddingPt: 9,
      borderColor: "#123456",
    });
    const html = await (await document.render({ format: "html" })).text();
    const svg = await (await document.render({ format: "svg" })).text();
    expect(html).not.toContain('<script data-x="1">');
    expect(html).toContain('&lt;script data-x="1"&gt;');
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("A\tB\nC");
    expect(html).toContain('<col style="width:144pt">');
    expect(html).toContain("border:1px solid #123456;padding:9pt");
    expect(svg).not.toContain('<script data-x="1">');
    expect(svg).toContain('&lt;script data-x="1"&gt;');
    expect(() => paragraph.append("unsafe", { fontFamily: 'Arial";background:url(x)' })).toThrow();
    expect(() => {
      (paragraph.runs[0]!.style as Record<string, unknown>).color = '#fff" onload="alert(1)';
    }).toThrow();
    const hostileSnapshot = document.toJSON();
    const hostileParagraph = hostileSnapshot.blocks[0];
    if (!hostileParagraph || hostileParagraph.kind !== "paragraph") {
      throw new Error("Expected paragraph fixture");
    }
    (hostileParagraph.runs[0]!.style as Record<string, unknown>).color = '#fff" onload="alert(1)';
    expect(() => Document.fromJSON(hostileSnapshot)).toThrow("Invalid or unsafe color");
    await expect(
      document.render({ format: "svg", background: 'white" onload="alert(1)' }),
    ).rejects.toThrow("Invalid or unsafe color");
    await expect(
      document.render({ format: "png", scale: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("render scale");
  });

  test("rejects hostile raster allocations before loading the native renderer", async () => {
    const huge = Document.create({
      ...deterministicOptions,
      page: { widthPt: 14_400, heightPt: 14_400 },
    });
    huge.blocks.addParagraph("A structurally valid page must still respect the raster budget.");
    await expect(huge.render({ format: "png" })).rejects.toBeInstanceOf(ArtifactLimitError);
    await expect(huge.render({ format: "png", scale: 2 })).rejects.toMatchObject({
      name: "ArtifactLimitError",
      limit: "document raster dimension",
      maximum: 32_768,
    });
    expect((await huge.render({ format: "svg" })).type).toBe("image/svg+xml");

    const complex = Document.create(deterministicOptions);
    complex.blocks.addParagraph("x".repeat(50_001));
    await expect(complex.render({ format: "png" })).rejects.toMatchObject({
      name: "ArtifactLimitError",
      limit: "document raster glyphs",
      maximum: 50_000,
    });
  });

  test("fails closed instead of producing ambiguous overlapping review markup", async () => {
    const document = Document.create(deterministicOptions);
    const paragraph = document.blocks.addParagraph("0123456789");
    document.changes.add({ block: paragraph, start: 1, end: 6 }, "insert");
    expect(() => document.changes.add({ block: paragraph, start: 4, end: 8 }, "delete")).toThrow(
      "must not overlap",
    );

    const comments = Document.create(deterministicOptions);
    const commented = comments.blocks.addParagraph("0123456789");
    comments.comments.addThread({ block: commented, start: 1, end: 6 }, "one");
    expect(() =>
      comments.comments.addThread({ block: commented, start: 4, end: 8 }, "two"),
    ).toThrow("nested or disjoint");

    const styled = Document.create(deterministicOptions);
    const styledParagraph = styled.blocks.addParagraph([
      new DocumentTextRun("mixed", { bold: true }),
      new DocumentTextRun(" styles", { italic: true }),
    ]);
    styled.changes.add(
      { block: styledParagraph, start: 0, end: styledParagraph.text.length },
      "insert",
    );
    await expect(DocumentFile.exportDocx(styled)).rejects.toBeInstanceOf(
      UnsupportedArtifactFeatureError,
    );
  });

  test("rejects hostile or internally inconsistent serialized snapshots", async () => {
    const document = Document.create(deterministicOptions);
    document.blocks.addParagraph("Safe");
    const snapshot = document.toJSON();

    expect(() => Document.fromJSON({ ...snapshot, idNamespace: "invalid" })).toThrow("idNamespace");
    expect(() => Document.fromJSON({ ...snapshot, nextId: Number.NaN })).toThrow("nextId");
    expect(() => Document.fromJSON({ ...snapshot, revision: -1 })).toThrow("revision");
    const exhausted = Document.fromJSON({ ...snapshot, revision: Number.MAX_SAFE_INTEGER });
    expect(() => exhausted.blocks.addParagraph("Cannot commit")).toThrow("revision space");
    expect(exhausted.blocks.items).toHaveLength(1);

    const injected = structuredClone(snapshot);
    const paragraph = injected.blocks[0];
    if (paragraph?.kind !== "paragraph") throw new Error("Fixture paragraph missing");
    (paragraph.style as Record<string, unknown>).alignment =
      "left;background-image:url(https://attacker.invalid/pixel)";
    expect(() => Document.fromJSON(injected)).toThrow("alignment");

    const noReplies = structuredClone(snapshot);
    noReplies.comments.push({
      id: `dc/${snapshot.idNamespace}00000000000000ff`,
      blockId: snapshot.blocks[0]!.id,
      start: 0,
      end: 0,
      resolved: false,
      replies: [],
    });
    noReplies.nextId = 0x100;
    expect(() => Document.fromJSON(noReplies)).toThrow("root reply");

    await expect(document.render({ format: "not-a-format" as "png" })).rejects.toThrow(
      "Unsupported document render format",
    );
    await expect(document.inspect({ kind: "document", maxChars: Number.NaN })).rejects.toThrow(
      "maxChars",
    );

    expect(() => document.blocks.addParagraph("bad\uFFFFtext")).toThrow("XML-forbidden");

    const foreignId = structuredClone(snapshot);
    if (foreignId.blocks[0]?.kind !== "paragraph") throw new Error("Fixture paragraph missing");
    foreignId.blocks[0].id = `p/8899aabbccddeeff0000000000000001`;
    expect(() => Document.fromJSON(foreignId)).toThrow("object id");

    const unknownStyle = structuredClone(snapshot) as SerializedDocument & {
      blocks: Array<SerializedDocument["blocks"][number] & { style: Record<string, unknown> }>;
    };
    unknownStyle.blocks[0]!.style.untrusted = true;
    expect(() => Document.fromJSON(unknownStyle)).toThrow(
      "Unknown document paragraph style property",
    );
  });
});

async function addSafeCustomXml(source: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(ownedArrayBuffer(source), { checkCRC32: true });
  const relationshipsPart = archive.file("word/_rels/document.xml.rels");
  const contentTypesPart = archive.file("[Content_Types].xml");
  if (!relationshipsPart || !contentTypesPart)
    throw new Error("Generated DOCX fixture is incomplete");
  const relationships = await relationshipsPart.async("text");
  const contentTypes = await contentTypesPart.async("text");
  archive.file(
    "word/_rels/document.xml.rels",
    insertBeforeClosing(
      relationships,
      "Relationships",
      '<Relationship Id="rIdCustomXmlFixture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>',
    ),
  );
  archive.file(
    "[Content_Types].xml",
    insertBeforeClosing(
      contentTypes,
      "Types",
      '<Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>',
    ),
  );
  archive.file(
    "customXml/item1.xml",
    '<?xml version="1.0"?><fixture xmlns="urn:opengeni:test">opaque</fixture>',
  );
  archive.file(
    "customXml/itemProps1.xml",
    '<?xml version="1.0"?><properties xmlns="urn:opengeni:test"/>',
  );
  archive.file(
    "customXml/_rels/item1.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>',
  );
  archive.forEach((_path, entry) => {
    entry.date = new Date(1980, 0, 1, 0, 0, 0, 0);
  });
  return archive.generateAsync({ type: "uint8array", compression: "STORE" });
}

function insertBeforeClosing(xml: string, element: string, insertion: string): string {
  const closing = `</${element}>`;
  const index = xml.lastIndexOf(closing);
  if (index < 0) throw new Error(`DOCX fixture lacks ${closing}`);
  return `${xml.slice(0, index)}${insertion}${xml.slice(index)}`;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
