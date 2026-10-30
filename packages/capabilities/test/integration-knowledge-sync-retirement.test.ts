import { expect, test } from "bun:test";
import { CORE_INTEGRATION_DEFINITIONS } from "../src";

test("no core integration offers a Knowledge source; integrations give agents tools", () => {
  const offered = CORE_INTEGRATION_DEFINITIONS.flatMap((definition) =>
    definition.facets
      .filter((facet) => facet.kind === "knowledge_source")
      .map((facet) => `${definition.id}:${facet.facetKey}`),
  );
  expect(offered).toEqual([]);
});
