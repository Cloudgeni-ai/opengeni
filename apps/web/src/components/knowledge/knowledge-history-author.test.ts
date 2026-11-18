import { describe, expect, test } from "bun:test";

import { parseKnowledgeSearch } from "../../lib/knowledge-route";
import { authorOf } from "./knowledge-history-author";

describe("who a Knowledge version names as its author", () => {
  const human = { id: "r1", createdBySessionId: null };
  test("your own change to a shared entry reads You, not A teammate", () => {
    expect(authorOf(human, "workspace", new Set(["r1"]))).toBe("You");
    expect(authorOf(human, "workspace", new Set(["r2"]))).toBe("A teammate");
    expect(authorOf(human, "personal")).toBe("You");
    expect(authorOf({ id: "r1", createdBySessionId: "s1" }, "workspace", new Set(["r1"]))).toBe(
      "Opengeni",
    );
  });
});

describe("a Knowledge link opened from an agent", () => {
  test("keeps the agent with its entry only", () => {
    expect(parseKnowledgeSearch({ entry: "e1", agent: "a1" })).toEqual({
      entry: "e1",
      agent: "a1",
    });
    expect(parseKnowledgeSearch({ agent: "a1" })).toEqual({});
  });
});
