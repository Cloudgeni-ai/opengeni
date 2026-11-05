---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The agent's shell now has `rg` (ripgrep 15.2.0) and `jq` (1.8.2) on every placement, including sandboxes on custom images, Connected Machines and run_on targets. Official release builds, pinned by SHA-256, ship with Opengeni's own runtime tools: the machine agent embeds its target's build and the worker delivers the Linux builds to managed sandboxes beside the Codemode client. Their directory is appended to the end of PATH, so a system `rg` or `jq` always wins, and nothing is downloaded when a command runs. Licence notices ship beside the binaries.
