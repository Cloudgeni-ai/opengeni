import { describe, expect, test } from "bun:test";

import { withOccurrenceKeys } from "./react-key";

describe("withOccurrenceKeys", () => {
  test("is deterministic and keeps duplicate content unique", () => {
    const items = [{ name: "same" }, { name: "same" }, { name: "other" }];

    const first = withOccurrenceKeys(items, (item) => item.name);
    const second = withOccurrenceKeys(items, (item) => item.name);

    expect(first.map(({ key }) => key)).toEqual(["same\u00001", "same\u00002", "other\u00001"]);
    expect(second.map(({ key }) => key)).toEqual(first.map(({ key }) => key));
    expect(first.map(({ item }) => item)).toEqual(items);
  });

  test("preserves content identity when unrelated rows are inserted", () => {
    const before = withOccurrenceKeys(["alpha", "omega"], (item) => item);
    const after = withOccurrenceKeys(["alpha", "middle", "omega"], (item) => item);

    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[2]?.key).toBe(before[1]?.key);
  });
});
