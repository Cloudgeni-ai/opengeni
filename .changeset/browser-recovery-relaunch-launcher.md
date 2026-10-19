---
"@opengeni/browserd": patch
---

Relaunch a recovered managed browser through the normal browser launcher instead of its recorded process image. On hosts where Chromium is installed behind a wrapper (NixOS, Debian, Google Chrome's own launcher script), the bare image skipped the wrapper's sandbox setup and aborted at startup, so a browser whose controller and Chrome had both gone away could never be opened again.
