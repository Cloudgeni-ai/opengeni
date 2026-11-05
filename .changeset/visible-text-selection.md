---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Selected text is clearly visible in dark and light themes. A new `--og-color-text-selection` token (a translucent blue) drives the page selection, text fields and the code editor, instead of a translucent mix of the neutral grey accent, which in dark mode looked like one more grey surface. The native composer on Android highlights with that token rather than the opaque accent, which covered the selected text; iOS keeps the system selection tint.
