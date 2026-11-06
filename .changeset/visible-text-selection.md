---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Selected text is clearly visible in dark and light themes. A new `--og-color-text-selection` token (a translucent blue) now drives the page selection, text fields (including the shared `Input` and `CopyField`, which had their own low-contrast selection colours), the code editor and the terminal. They used to take a translucent mix of the neutral grey accent, which in dark mode looked like one more grey surface. Hosts that want a branded selection colour override the new token; the selection no longer follows `--og-color-accent`. In the native composer, Android uses the token for the highlight, which was previously the opaque grey accent and left the selected text hard to read, while the caret and handles stay on the accent. On iOS the composer now uses the app's tint (system blue by default) instead of the grey accent.
