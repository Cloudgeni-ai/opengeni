import { expect, test } from "bun:test";

import { Document, DocumentTextRun } from "../src/document";

test("SerializedDocument v1 stays aligned with the native semantic vector", async () => {
  const expected = (await Bun.file(
    new URL("./fixtures/document-native-semantic-vector.json", import.meta.url),
  ).json()) as unknown;
  const document = Document.create({
    idNamespace: "0011223344556677",
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  const first = document.sections.items[0]!;
  first.headers.default.addParagraph("OpenGeni brief");
  first.footers.default.addParagraph("Confidential");
  document.blocks.addHeading("Launch decision", 1);
  const recommendation = document.blocks.addParagraph([
    new DocumentTextRun("Recommendation: ", { bold: true }),
    new DocumentTextRun("ship the engine."),
  ]);
  recommendation.replace("ship", "release");
  document.blocks.addParagraph("Verify fidelity", {
    list: { kind: "number", level: 0 },
  });
  document.blocks.addTable(
    [
      ["Area", "Result"],
      ["Comments", "Editable"],
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
  document.blocks.addParagraph("Evidence.");
  document.comments.setSelf({ displayName: "Reviewer" });
  const comment = document.comments.addThread(
    { block: recommendation, start: 0, end: 14 },
    "Confirm.",
  );
  comment.addReply("Confirmed.", "Author");
  comment.resolve();
  document.changes.add({ block: recommendation, start: 16, end: 23 }, "insert", "Author");

  const validatedExpected = Document.fromJSON(expected).toJSON();
  expect(document.toJSON()).toEqual(validatedExpected);
});
