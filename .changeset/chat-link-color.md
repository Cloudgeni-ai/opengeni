---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Links in chat replies are easy to see. A new `link` color token (`--og-color-link` on web, `link` in the native theme) colors every text link a calm blue in both themes, readable on every chat surface. The native chat now underlines links like the web chat, announces them as links and shows a soft wash while one is pressed. Web URLs, autolinked URLs, artifact, Site, chat and file links, and links in lists and tables all share the style. Hosts that rebranded links through `--og-color-accent-strong` set `--og-color-link` instead.
