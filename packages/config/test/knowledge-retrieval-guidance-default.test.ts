import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("Knowledge retrieval guidance is on by default and can be turned off", () => {
  expect(getSettings({ OPENGENI_ENV: "test" }).experimentKnowledgeRetrievalGuidance).toBe(true);
  expect(
    getSettings({ OPENGENI_ENV: "test", OPENGENI_EXPERIMENT_KNOWLEDGE_RETRIEVAL_GUIDANCE: "false" })
      .experimentKnowledgeRetrievalGuidance,
  ).toBe(false);
});
