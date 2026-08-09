import { describe, expect, test as bunTest } from "bun:test";

import { Document, DocumentFile, DocumentTextRun, configureArtifactRuntime } from "../src";
import {
  productionTestRuntime,
  productionTestRuntimeAvailable,
} from "./production-runtime-fixture";

const nativeRuntimeAvailable = productionTestRuntimeAvailable();
const test = nativeRuntimeAvailable ? bunTest : bunTest.skip;
if (nativeRuntimeAvailable) configureArtifactRuntime(productionTestRuntime());

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function expectPng(bytes: Uint8Array): void {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
}

describe("document skill public-workflow conformance", () => {
  test("creates, edits, reviews, inspects, helps, renders, exports, and imports through the public entrypoint", async () => {
    const document = Document.create({
      idNamespace: "0011223344556677",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const firstSection = document.sections.items[0]!;
    firstSection.headers.default.addParagraph("OpenGeni brief");
    firstSection.footers.default.addParagraph("Confidential");

    document.blocks.addHeading("Launch decision", 1);
    const recommendation = document.blocks.addParagraph([
      new DocumentTextRun("Recommendation: ", { bold: true }),
      new DocumentTextRun("ship the bounded editable artifact engine."),
    ]);
    recommendation.replace("ship", "release");
    document.blocks.addParagraph("Verify public API compatibility", {
      list: { kind: "number", level: 0 },
    });
    document.blocks.addParagraph("Verify editable DOCX fidelity", {
      list: { kind: "number", level: 0 },
    });
    document.blocks.addTable(
      [
        ["Area", "Result"],
        ["Comments", "Editable"],
        ["Redlines", "Editable"],
      ],
      {
        widthPt: 360,
        columnWidthsPt: [210, 150],
        headerRows: 1,
        headerFill: "#E5E7EB",
      },
    );

    const appendix = document.sections.add({
      page: { widthPt: 792, heightPt: 612, marginLeftPt: 54, marginRightPt: 54 },
    });
    appendix.headers.first.addParagraph("Appendix");
    document.blocks.addParagraph("Rendered verification evidence.");

    document.comments.setSelf({ displayName: "Reviewer" });
    const thread = document.comments.addThread(
      { block: recommendation, start: 0, end: 14 },
      "Confirm the decision wording.",
    );
    thread.addReply("Confirmed.", "Author");
    thread.resolve();
    document.changes.add({ block: recommendation, start: 16, end: 23 }, "insert", "Author");

    const inspection = await document.inspect({
      kind: "document,section,paragraph,table,comment,redline",
      maxChars: 20_000,
    });
    expect(inspection.truncated).toBe(false);
    expect(inspection.ndjson).toContain("Launch decision");
    expect(inspection.ndjson).toContain("Confirm the decision wording");
    expect(inspection.ndjson).toContain('"changeKind":"insert"');

    const help = document.help("comments.addThread", { include: "index,examples" });
    expect(help.ndjson).toContain("document.comments.addThread");
    expect(help.ndjson).toContain("thread.addReply");

    expectPng(await bytesOf(await document.render({ format: "png", scale: 1 })));

    const docx = await DocumentFile.exportDocx(document);
    const docxBytes = await bytesOf(docx);
    expect(Array.from(docxBytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const restored = await DocumentFile.importDocx(docx);
    expect(restored.sections.items).toHaveLength(2);
    expect(restored.comments.items[0]).toMatchObject({ resolved: true });
    expect(restored.changes.items[0]).toMatchObject({ kind: "insert" });
    expect((await restored.inspect({ kind: "paragraph,table" })).ndjson).toContain(
      "editable DOCX fidelity",
    );
  }, 30_000);
});
