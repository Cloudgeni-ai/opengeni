import { describe, expect, test } from "bun:test";
import {
  adfToMarkdown,
  confluenceCursor,
  knowledgeSyncObservationPolicy,
} from "../src/activities/knowledge-source-sync";

describe("knowledge sync provider coexistence", () => {
  test("keeps Atlassian outside Google Drive revision filtering", () => {
    expect(knowledgeSyncObservationPolicy("google_drive")).toEqual({
      revisionOrdering: "canonical_decimal",
      filterWithDriveDurability: true,
    });
    expect(knowledgeSyncObservationPolicy("atlassian")).toEqual({
      revisionOrdering: "first_observation",
      filterWithDriveDurability: false,
    });
  });
});

describe("Atlassian content projection", () => {
  test("renders common Jira ADF without exposing provider JSON", () => {
    expect(
      adfToMarkdown({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Acceptance criteria" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Open the " },
              {
                type: "text",
                text: "runbook",
                marks: [{ type: "link", attrs: { href: "https://example.com/runbook" } }],
              },
            ],
          },
        ],
      }),
    ).toContain("## Acceptance criteria\n\nOpen the [runbook](https://example.com/runbook)");
  });

  test("extracts a bounded cursor from relative Confluence links", () => {
    expect(confluenceCursor("/wiki/api/v2/pages?limit=100&cursor=abc123")).toBe("abc123");
    expect(confluenceCursor(null)).toBeNull();
    expect(() => confluenceCursor("/wiki/api/v2/pages?cursor=")).toThrow(
      "invalid Confluence cursor",
    );
  });
});
