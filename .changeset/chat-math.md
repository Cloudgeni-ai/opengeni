---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Chat messages now render math. Inline and display TeX written with `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is typeset with KaTeX on the web and as SVG (MathJax's TeX font, no WebView) in the native timeline, instead of showing as source with its backslashes stripped. Single dollars follow Pandoc's rule, so prices such as `$5 and $10` stay text, and code spans and fenced code are never touched. The math renderer loads on the first message that contains math: KaTeX is a separate lazy chunk on the web, and the native MathJax engine is evaluated only on first use. Invalid TeX shows its source instead of breaking the message. The shared delimiter handling is exported as `@opengeni/react/markdown-math` (`prepareMathMarkdown`, `mayContainMath`).
