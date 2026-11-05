---
"@opengeni/config": patch
---

The default Modal Computer/Browser image is now current: it carries pdftotext and pdfinfo (poppler-utils), uuidgen, the git identity setup and the latest browser engines. Packaged Helm charts now always default to the desktop image built from their own source, so the chart's desktop pin can no longer lag behind a release.
