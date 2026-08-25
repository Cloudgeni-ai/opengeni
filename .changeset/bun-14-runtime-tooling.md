---
"@opengeni/ogtool": patch
"@opengeni/runtime": patch
---

Adopt the canonical Bun 1.4 toolchain, build the standalone ogtool CLI with Bun, and use Bun 1.4's corrected UTF-8 byte-length behavior in runtime context compaction.