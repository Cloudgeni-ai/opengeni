import { describe, expect, test } from "bun:test";

import { withoutProviderTracking, withoutProviderTrackingInText } from "../src/citation-urls";

describe("withoutProviderTracking", () => {
  test("removes the provider source and the search query the hosted search added", () => {
    expect(
      withoutProviderTracking(
        "https://www.example.org/guides/opening-hours?_t_q=caf%C3%A9+opening+hours&utm_source=openai",
      ),
    ).toBe("https://www.example.org/guides/opening-hours");
  });

  test("drops the question mark when nothing else is left", () => {
    expect(withoutProviderTracking("https://example.com/a?utm_source=openai")).toBe(
      "https://example.com/a",
    );
    expect(withoutProviderTracking("https://example.com/?utm_source=chatgpt.com")).toBe(
      "https://example.com/",
    );
    expect(withoutProviderTracking("https://example.com/a?utm_source=ChatGPT")).toBe(
      "https://example.com/a",
    );
  });

  test("keeps the page's own parameters in order and as written", () => {
    expect(withoutProviderTracking("https://example.com/v?sfns=mo&utm_source=openai")).toBe(
      "https://example.com/v?sfns=mo",
    );
    expect(
      withoutProviderTracking(
        "https://example.com/p?id=7&utm_medium=Organic&q=a%20b+c&utm_source=openai&hl=nb",
      ),
    ).toBe("https://example.com/p?id=7&utm_medium=Organic&q=a%20b+c&hl=nb");
  });

  test("keeps the fragment", () => {
    expect(withoutProviderTracking("https://example.com/a?x=1&utm_source=openai#part-2")).toBe(
      "https://example.com/a?x=1#part-2",
    );
    expect(withoutProviderTracking("https://example.com/a?utm_source=openai#top")).toBe(
      "https://example.com/a#top",
    );
  });

  test("leaves links without the provider's source alone", () => {
    for (const url of [
      "https://example.com/a",
      "https://example.com/a?utm_source=newsletter&_t_q=kept",
      "https://example.com/a?_t_q=only",
      "https://example.com/a#x?utm_source=openai",
      "https://example.com/a?utm_source=openai-labs",
      "not a url ?utm_source",
      "",
    ]) {
      expect(withoutProviderTracking(url)).toBe(url);
    }
  });

  test("recognizes an encoded key or value", () => {
    expect(withoutProviderTracking("https://example.com/a?b=1&utm%5Fsource=OpenAI")).toBe(
      "https://example.com/a?b=1",
    );
    expect(withoutProviderTracking("https://example.com/a?b=%E0%A4&utm_source=openai")).toBe(
      "https://example.com/a?b=%E0%A4",
    );
  });

  test("is idempotent", () => {
    const once = withoutProviderTracking("https://example.com/a?x=1&_t_q=q&utm_source=openai");
    expect(withoutProviderTracking(once)).toBe(once);
  });
});

describe("withoutProviderTrackingInText", () => {
  test("cleans source links in a cited answer", () => {
    const answer =
      "The café opens at nine ([example.org](https://www.example.org/guides/opening-hours?_t_q=caf%C3%A9+hours&utm_source=openai)).\n" +
      "See also [the guide](https://example.com/guide?utm_source=openai) and <https://example.com/x?y=2&utm_source=openai>.";
    expect(withoutProviderTrackingInText(answer)).toBe(
      "The café opens at nine ([example.org](https://www.example.org/guides/opening-hours)).\n" +
        "See also [the guide](https://example.com/guide) and <https://example.com/x?y=2>.",
    );
  });

  test("cleans bare URLs and leaves sentence punctuation", () => {
    expect(
      withoutProviderTrackingInText(
        "Read https://example.com/a?utm_source=openai. Or https://example.com/b?k=v&utm_source=openai, then stop!",
      ),
    ).toBe("Read https://example.com/a. Or https://example.com/b?k=v, then stop!");
  });

  test("keeps parentheses that belong to the URL", () => {
    expect(
      withoutProviderTrackingInText(
        "([Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar)?utm_source=openai))",
      ),
    ).toBe("([Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar)))");
  });

  test("cleans a URL used as its own link label", () => {
    expect(
      withoutProviderTrackingInText(
        "[https://example.com/a?utm_source=openai](https://example.com/a?utm_source=openai)",
      ),
    ).toBe("[https://example.com/a](https://example.com/a)");
  });

  test("leaves code exactly as written", () => {
    const text = [
      "Link: https://example.com/a?utm_source=openai",
      "`curl https://example.com/b?utm_source=openai`",
      "```",
      "fetch('https://example.com/c?utm_source=openai')",
      "```",
      "",
    ].join("\n");
    expect(withoutProviderTrackingInText(text)).toBe(
      text.replace("https://example.com/a?utm_source=openai", "https://example.com/a"),
    );
  });

  test("leaves other tracking and text without URLs unchanged", () => {
    for (const text of [
      "No links here.",
      "[shop](https://example.com/p?utm_source=newsletter&utm_medium=email)",
      "utm_source=openai on its own",
      "",
    ]) {
      expect(withoutProviderTrackingInText(text)).toBe(text);
    }
  });

  test("is idempotent", () => {
    const once = withoutProviderTrackingInText(
      "[a](https://example.com/a?x=1&utm_source=openai) https://example.com/b?utm_source=openai",
    );
    expect(withoutProviderTrackingInText(once)).toBe(once);
  });
});
