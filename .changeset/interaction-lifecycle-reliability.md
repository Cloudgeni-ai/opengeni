---
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Fix attached-browser event pagination and dedicated-tab creation, isolate concurrent macOS native capture helpers, separate still screenshots from live-stream reads, and serialize exact frame bytes. Preserve bounded controller diagnostics, read legacy browser capabilities conservatively, and respect explicit placement and identity when reusing interaction resources. Install matching agent and controller builds together; native capture uses protocol version 3.
