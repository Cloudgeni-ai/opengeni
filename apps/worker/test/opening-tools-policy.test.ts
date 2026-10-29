import { describe, expect, test } from "bun:test";
import { OPENING_TOOLS_METADATA_KEY } from "@opengeni/contracts";
import { openingToolNamesForTurn } from "../src/activities/agent-turn/tool-policy";

describe("opening tools for a turn", () => {
  const metadata = { [OPENING_TOOLS_METADATA_KEY]: ["excel_run", "excel_run", 7, ""] };

  test("Responses and Chat routes load the turn's frozen opening tools", () => {
    for (const api of ["responses", "chat"] as const) {
      expect(openingToolNamesForTurn({ provider: { api } }, metadata)).toEqual(["excel_run"]);
    }
    expect(openingToolNamesForTurn(null, metadata)).toEqual(["excel_run"]);
  });

  test("Anthropic Messages routes load nothing; the model searches as usual", () => {
    expect(openingToolNamesForTurn({ provider: { api: "anthropic-messages" } }, metadata)).toEqual(
      [],
    );
  });

  test("turns without opening tools load nothing", () => {
    expect(openingToolNamesForTurn({ provider: { api: "responses" } }, {})).toEqual([]);
    expect(openingToolNamesForTurn({ provider: { api: "responses" } }, null)).toEqual([]);
  });
});
