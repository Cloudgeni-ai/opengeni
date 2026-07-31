import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { ensureSelectedModelRow, projectPickerRows, sortPickerRows } from "@opengeni/react";

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

  test("injects a stale selected model without duplicating catalog ids", () => {
    const rows = ensureSelectedModelRow(
      projectPickerRows([catalogModel("gpt-5.6-sol")]),
      "legacy-model",
      "Legacy model",
    );
    expect(rows.filter((row) => row.id === "legacy-model")).toHaveLength(1);
    expect(rows.filter((row) => row.id === "gpt-5.6-sol")).toHaveLength(1);
    expect(rows.find((row) => row.id === "legacy-model")?.selectable).toBe(false);
  });
});
