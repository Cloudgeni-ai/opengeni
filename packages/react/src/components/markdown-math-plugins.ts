/* Loaded on demand by `Markdown` the first time a message contains math, so KaTeX and
   its stylesheet stay out of the eager bundle. */
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

/** `$$…$$` only: `prepareMathMarkdown` has already turned every math span into it. */
export const remarkMathPlugin = [remarkMath, { singleDollarTextMath: false }] as const;

/** Typesets math nodes; bad TeX shows as its source instead of breaking the message. */
export const rehypeKatexPlugin = [
  rehypeKatex,
  { throwOnError: false, errorColor: "currentColor", strict: "ignore", output: "htmlAndMathml" },
] as const;
