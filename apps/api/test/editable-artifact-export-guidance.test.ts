import { expect, test } from "bun:test";
import { unsupportedEditableArtifactExport } from "@opengeni/core/editable-artifacts";
import { editableArtifactHttpError } from "../src/routes/editable-artifacts";

test("REST preserves configured supported-format guidance for SDK callers", () => {
  const error = unsupportedEditableArtifactExport("document", "pdf", {
    spreadsheet: ["xlsx"],
    document: ["docx"],
    presentation: [],
  });
  const mapped = editableArtifactHttpError(error) as { message: string; code: string };
  expect(mapped.message).toContain("document → docx");
  expect(mapped.code).toBe("validation_failed");
});
