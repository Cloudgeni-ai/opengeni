---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": patch
---

Add the opt-in `fitViewport` prop to `BrowserViewer`. An embed can fit a managed Chromium page to its panel without cropping or overriding an explicitly set viewport. The console still scales its existing frame. Only viewer-fitted sizes carry to new tabs.
