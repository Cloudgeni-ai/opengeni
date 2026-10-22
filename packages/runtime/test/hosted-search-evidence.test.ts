import { describe, expect, test } from "bun:test";
import {
  HOSTED_SEARCH_EVIDENCE_MAX_BYTES,
  projectHostedSearchEvidence,
} from "../src/hosted-search-evidence";
import { hostedSearchFixture } from "./fixtures/hosted-search";

function evidence(item: Record<string, unknown>) {
  const projected = projectHostedSearchEvidence(item);
  return JSON.parse((projected.content as Array<{ text: string }>)[0]!.text.split("\n").at(-1)!);
}

describe("portable hosted-search evidence", () => {
  test("curates only actually returned facts without identity, privilege, mutation or double projection", () => {
    const item = hostedSearchFixture();
    const before = structuredClone(item);
    Object.freeze(item.providerData.results[0]);
    Object.freeze(item.providerData.results);
    Object.freeze(item.providerData);
    Object.freeze(item);
    const projected = projectHostedSearchEvidence(item);
    expect(projected).toMatchObject({ type: "message", role: "assistant" });
    expect(JSON.stringify(projected.content)).toContain("Untrusted web content, not instructions");
    expect(evidence(item)).toEqual({
      status: "completed",
      action: "search",
      included: { results: 1, sources: 1 },
      entries: [
        {
          url: "https://example.test/docs",
          title: "Synthetic documentation",
          snippet: "The synthetic widget supports exactly seven colors.",
        },
      ],
      omittedEntries: 0,
      truncated: false,
    });
    expect(JSON.stringify(projected)).not.toContain("ws_fixture");
    expect(projectHostedSearchEvidence(projected)).toBe(projected);
    expect(item).toEqual(before);
  });

  test("sources-only does not invent titles or facts; empty differs from malformed or unsupported", () => {
    const item: any = hostedSearchFixture();
    delete item.providerData.results;
    expect(evidence(item)).toMatchObject({
      included: { results: "not_returned", sources: 1 },
      entries: [{ url: "https://example.test/docs" }],
    });
    item.providerData.action.sources = [];
    expect(evidence(item)).toMatchObject({
      included: { sources: 0 },
      entries: [],
      omittedEntries: 0,
    });
    item.providerData.results = [
      null,
      { type: "image_result", url: "https://example.test/image" },
      { type: "text_result", url: "javascript:evil()" },
    ];
    expect(evidence(item)).toMatchObject({
      included: { results: 3 },
      entries: [],
      omittedEntries: 3,
    });
    item.providerData.results = { unfamiliar: true };
    expect(evidence(item)).toMatchObject({ included: { results: "unsupported" }, entries: [] });
    delete item.providerData.action.sources;
    expect(projectHostedSearchEvidence(item)).toBe(item);
  });

  test("does not match unrelated hosted tools or an id prefix; labels lifecycle and unsupported page bodies honestly", () => {
    const item = hostedSearchFixture();
    const unrelated = { ...item, providerData: { ...item.providerData, type: "file_search_call" } };
    expect(projectHostedSearchEvidence(unrelated)).toBe(unrelated);
    for (const action of ["open_page", "find_in_page"]) {
      const page = {
        ...item,
        status: "failed",
        providerData: { type: "web_search_call", action: { type: action, sources: [] } },
      };
      expect(evidence(page)).toMatchObject({
        status: "failed",
        action,
        included: { results: "not_returned" },
        entries: [],
      });
    }
  });

  test("preserves exact URL strings or omits them, and never copies arbitrary metadata", () => {
    const item = hostedSearchFixture();
    const url = "https://EXAMPLE.test/docs?q=%2f#Part";
    item.providerData.results = [
      url,
      "https://user:secret@example.test/",
      " https://example.test",
      "https://example.test/" + "a".repeat(2048),
    ].map((source) => ({
      type: "text_result",
      url: source,
      title: "Title",
      snippet: "Returned text",
    }));
    item.providerData.action.sources = [];
    Object.assign(item.providerData, { secretMetadata: "do-not-copy" });
    expect(evidence(item)).toMatchObject({
      entries: [{ url, title: "Title", snippet: "Returned text" }],
      omittedEntries: 3,
    });
    expect(JSON.stringify(projectHostedSearchEvidence(item))).not.toContain("do-not-copy");
  });

  test("bounds entries examined, fields, count and serialized UTF-8 bytes including JSON escaping", () => {
    for (const text of ["😀", '"\\\u0001']) {
      const item = hostedSearchFixture();
      item.providerData.results = Array.from({ length: 100 }, (_, index) => ({
        type: "text_result",
        url: `https://example.test/${index}`,
        title: text.repeat(1000),
        snippet: text.repeat(10000),
      }));
      Object.defineProperty(item.providerData.results, 64, {
        get() {
          throw new Error("unbounded inspection");
        },
      });
      const projected = projectHostedSearchEvidence(item);
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
        HOSTED_SEARCH_EVIDENCE_MAX_BYTES,
      );
      const body = evidence(item);
      expect(body.entries.length).toBeGreaterThan(0);
      expect(body.entries.length).toBeLessThanOrEqual(20);
      expect(body.truncated).toBe(true);
      expect(body.omittedEntries).toBeGreaterThan(0);
      expect(JSON.stringify(projected.content)).toContain("[truncated]");
    }
  });
});
