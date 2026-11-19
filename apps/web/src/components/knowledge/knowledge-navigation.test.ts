import { describe, expect, test } from "bun:test";

import {
  entrySearch,
  keepAgentContext,
  pageSearch,
  parseKnowledgeSearch,
  type KnowledgeSearch,
} from "./knowledge-navigation";

/** Through the URL, as the router hands it back. */
const roundTrip = (search: KnowledgeSearch) => parseKnowledgeSearch({ ...search });

describe("an entry opened from an agent's Memory", () => {
  const fromAgent = parseKnowledgeSearch({ entry: "memory", agent: "agent-1" });

  test("keeps the agent on another version of the same entry", () => {
    const older = entrySearch("memory", {
      revision: "r1",
      from: "library",
      ...keepAgentContext(fromAgent, "memory"),
    });
    expect(roundTrip(older)).toEqual({
      entry: "memory",
      revision: "r1",
      agent: "agent-1",
    });
  });

  test("keeps the agent through Edit, then Close or Save", () => {
    const edit = roundTrip(
      pageSearch("edit", { entry: "memory", ...keepAgentContext(fromAgent, "memory") }),
    );
    expect(edit).toEqual({ page: "edit", entry: "memory", agent: "agent-1" });
    expect(roundTrip(entrySearch("memory", keepAgentContext(edit, "memory")))).toEqual({
      entry: "memory",
      agent: "agent-1",
    });
  });

  test("leaves the agent behind for another entry", () => {
    expect(keepAgentContext(fromAgent, "other")).toEqual({});
    expect(entrySearch("other", keepAgentContext(fromAgent, "other"))).toEqual({ entry: "other" });
    expect(keepAgentContext(parseKnowledgeSearch({ entry: "memory" }), "memory")).toEqual({});
  });
});
