import { describe, expect, test } from "bun:test";

import { generatedPlaceholderReason, validateLogoAsset } from "../src/logo-asset";

const svg = (text: string) => new TextEncoder().encode(text);

// The two letter avatars integrations.sh serves for a domain it has no logo
// for (the Google Search Console row returned the first one as its "logo").
const INTEGRATIONS_SH_LETTER = svg(`<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect fill="#f5f5f5" height="200" width="200"/>
  <text dominant-baseline="central" fill="#333333" font-family="sans-serif" font-size="120" font-weight="bold" text-anchor="middle" x="100" y="100">S</text>
</svg>`);
const INTEGRATIONS_SH_TINTED_LETTER = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="hsl(304 12% 88%)"/><text x="32" y="33" fill="hsl(304 14% 34%)" font-family="ui-sans-serif,system-ui,sans-serif" font-size="34" font-weight="600" text-anchor="middle" dominant-baseline="middle">P</text></svg>`,
);
const SIMPLE_ICONS_MARK = svg(
  `<svg fill="#458CF5" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Google Search Console</title><path d="M8.548 1.156L6.832 2.872v1.682h1.716z"/></svg>`,
);
const WORDMARK_WITH_TEXT = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24"><path d="M0 0h24v24H0z"/><text x="30" y="18">Acme</text></svg>`,
);
const TEXT_ONLY_WORDMARK = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24"><text x="0" y="18">Acme Cloud</text></svg>`,
);
const RECT_THREE_LETTER_WORDMARK = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 24"><rect width="64" height="24" fill="#1f70c1"/><text x="4" y="18">IBM</text></svg>`,
);
const RECT_EMPTY_TEXT = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/><text x="32" y="32"> </text></svg>`,
);
const RECT_ENTITY_LETTERS = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/><text x="32" y="32">A&amp;T</text></svg>`,
);
const RECT_ENTITY_LETTER = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/><text x="32" y="32">&#x26;</text></svg>`,
);
const LETTER_WITHOUT_BACKGROUND = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="32">S</text></svg>`,
);

describe("generated letter placeholders", () => {
  test("recognizes both integrations.sh letter avatars", () => {
    expect(generatedPlaceholderReason("image/svg+xml", INTEGRATIONS_SH_LETTER)).toBe(
      "generated_letter_placeholder",
    );
    expect(generatedPlaceholderReason("image/svg+xml", INTEGRATIONS_SH_TINTED_LETTER)).toBe(
      "generated_letter_placeholder",
    );
  });

  test("never mistakes a drawn mark or a wordmark for a placeholder", () => {
    expect(generatedPlaceholderReason("image/svg+xml", SIMPLE_ICONS_MARK)).toBeNull();
    expect(generatedPlaceholderReason("image/svg+xml", WORDMARK_WITH_TEXT)).toBeNull();
    expect(generatedPlaceholderReason("image/svg+xml", TEXT_ONLY_WORDMARK)).toBeNull();
    expect(generatedPlaceholderReason("image/png", INTEGRATIONS_SH_LETTER)).toBeNull();
  });

  test("only a background rectangle with one or two visible characters is a placeholder", () => {
    // A real three-letter wordmark on a block, or an empty text node, is kept.
    expect(generatedPlaceholderReason("image/svg+xml", RECT_THREE_LETTER_WORDMARK)).toBeNull();
    expect(generatedPlaceholderReason("image/svg+xml", RECT_EMPTY_TEXT)).toBeNull();
    expect(generatedPlaceholderReason("image/svg+xml", LETTER_WITHOUT_BACKGROUND)).toBeNull();
    // Entities count as the character they render.
    expect(generatedPlaceholderReason("image/svg+xml", RECT_ENTITY_LETTERS)).toBeNull();
    expect(generatedPlaceholderReason("image/svg+xml", RECT_ENTITY_LETTER)).toBe(
      "generated_letter_placeholder",
    );
  });

  test("the catalog's acceptance rule refuses a placeholder so the UI monogram takes over", () => {
    expect(
      validateLogoAsset({
        contentType: "image/svg+xml",
        bytes: INTEGRATIONS_SH_LETTER,
        rejectGeneratedPlaceholder: true,
      }),
    ).toEqual({ ok: false, reason: "generated_letter_placeholder" });
    expect(
      validateLogoAsset({
        contentType: "image/svg+xml; charset=utf-8",
        bytes: SIMPLE_ICONS_MARK,
        rejectGeneratedPlaceholder: true,
      }).ok,
    ).toBe(true);
  });

  test("a server's own declared letter icon is still accepted outside the catalog", () => {
    expect(
      validateLogoAsset({ contentType: "image/svg+xml", bytes: INTEGRATIONS_SH_LETTER }).ok,
    ).toBe(true);
  });
});
