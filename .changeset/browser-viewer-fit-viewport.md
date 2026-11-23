---
"@opengeni/react": minor
---

Add the opt-in `fitViewport` prop to `BrowserViewer`. It lets a visible viewer resize a managed Chromium page to its panel so the page can reflow instead of shrinking inside black bands. The built-in browser panel uses it; standalone viewers retain their existing behavior unless their host opts in.
