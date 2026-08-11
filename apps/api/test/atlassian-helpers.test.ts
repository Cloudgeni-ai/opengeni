import { describe, expect, test } from "bun:test";
import { confluenceNextUrl, isSelectableConfluenceSpaceType } from "../src/integrations/atlassian";

describe("Atlassian Confluence pagination", () => {
  test("keeps provider-relative v2 links under the selected cloud site", () => {
    expect(
      confluenceNextUrl("cloud-1", "/wiki/api/v2/spaces?limit=100&cursor=next").toString(),
    ).toBe(
      "https://api.atlassian.com/ex/confluence/cloud-1/wiki/api/v2/spaces?limit=100&cursor=next",
    );
  });

  test("rejects pagination that crosses the Atlassian API origin", () => {
    expect(() => confluenceNextUrl("cloud-1", "https://example.com/next")).toThrow(
      "crossed the Atlassian API origin",
    );
  });

  test("includes current template spaces but excludes personal spaces", () => {
    expect(isSelectableConfluenceSpaceType("global")).toBe(true);
    expect(isSelectableConfluenceSpaceType("onboarding")).toBe(true);
    expect(isSelectableConfluenceSpaceType("knowledge_base")).toBe(true);
    expect(isSelectableConfluenceSpaceType("personal")).toBe(false);
  });
});
