import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchText } from "./search-text";

describe("search snippet highlights", () => {
  test("matches literal syntax and all case-insensitive occurrences", () => {
    const html = renderToStaticMarkup(<SearchText text="PR_100% [a.*] pr_100%" query="pr_100%" />);
    expect(html.match(/<mark /g)?.length).toBe(2);
    expect(html).toContain("[a.*]");
    expect(renderToStaticMarkup(<SearchText text="[a.*]" query="[a.*]" />)).toContain(
      ">[a.*]</mark>",
    );
  });

  test("escapes untrusted markup and handles Unicode without cutting surrogate pairs", () => {
    const html = renderToStaticMarkup(
      <SearchText text={'😀 <script>alert("x")</script> 😀'} query="😀" />,
    );
    expect(html.match(/<mark /g)?.length).toBe(2);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("empty query does not create empty marks", () => {
    expect(renderToStaticMarkup(<SearchText text="test" query="" />)).toBe("test");
  });
});
