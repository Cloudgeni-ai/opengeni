import { useEffect, useMemo } from "react";

export type UnicodeFontNeeds = {
  japanese: boolean;
  arabic: boolean;
};

const japaneseScript = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const arabicScript = /[\u0600-\u06ff\u0750-\u077f\u0870-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/u;

export function detectUnicodeFontNeeds(values: Iterable<string>): UnicodeFontNeeds {
  let japanese = false;
  let arabic = false;
  for (const value of values) {
    japanese ||= japaneseScript.test(value);
    arabic ||= arabicScript.test(value);
    if (japanese && arabic) break;
  }
  return { japanese, arabic };
}

/**
 * Load large script-specific font manifests only when visible workspace content
 * needs them. Fontsource splits the actual glyphs by unicode-range, so Chromium
 * then fetches only the small shards used by the path instead of charging every
 * Latin-only session for the complete font.
 */
export function useUnicodeFallbackFonts(values: readonly string[]): void {
  const content = useMemo(() => collectUnicodeContent(values), [values]);
  useEffect(() => {
    if (content.japanese) {
      void import("./noto-sans-jp-loader.generated")
        .then(({ loadNotoSansJp }) => loadNotoSansJp(content.japanese))
        .catch(() => undefined);
    }
    if (content.arabic) {
      void import("./noto-sans-arabic-loader")
        .then(({ loadNotoSansArabic }) => loadNotoSansArabic())
        .catch(() => undefined);
    }
  }, [content.arabic, content.japanese]);
}

function collectUnicodeContent(values: Iterable<string>): {
  japanese: string;
  arabic: string;
} {
  const japanese = new Set<string>();
  const arabic = new Set<string>();
  for (const value of values) {
    for (const character of value) {
      if (japaneseScript.test(character)) japanese.add(character);
      if (arabicScript.test(character)) arabic.add(character);
    }
  }
  return { japanese: [...japanese].join(""), arabic: [...arabic].join("") };
}
