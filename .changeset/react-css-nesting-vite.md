---
"@opengeni/react": patch
---

`@opengeni/react/compiled.css` no longer triggers Vite's "Transforming this CSS nesting syntax is not supported" build warning. The markdown table's last-row rule now nests with a leading `&`, which bundlers flatten for their default browser targets.
