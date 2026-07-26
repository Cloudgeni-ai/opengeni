import fontUrl from "@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-arabic-wght-normal.woff2";
import unicodeRanges from "@fontsource-variable/noto-sans-arabic/unicode.json";

let loading: Promise<void> | undefined;

export function loadNotoSansArabic(): Promise<void> {
  loading ??= new FontFace(
    "Noto Sans Arabic Variable",
    `url("${fontUrl}") format("woff2-variations")`,
    { style: "normal", weight: "100 900", unicodeRange: unicodeRanges.arabic },
  )
    .load()
    .then((font) => {
      document.fonts.add(font);
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}
