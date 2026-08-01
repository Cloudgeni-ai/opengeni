import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { findPickerRow, projectPickerRows, sortPickerRows } from "@opengeni/react";

function catalogModel(id: string): WorkspaceModelCatalogModel {
  return {
    id,
    label: id,
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    availability: {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
  };
}

describe("workspace model catalog projection", () => {
  test("does not duplicate the same model id in projected rows", () => {
    const rows = sortPickerRows(
      projectPickerRows([catalogModel("gpt-5.6-sol"), catalogModel("gpt-5.6-terra")]),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  test("unknown selection is simply absent — no invented catalog row", () => {
    const rows = projectPickerRows([catalogModel("gpt-5.6-sol")]);
    expect(findPickerRow(rows, "legacy-model")).toBeNull();
    expect(findPickerRow(rows, "codex/gpt-5.6-luna")).toBeNull();
    expect(rows.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
  });
});
