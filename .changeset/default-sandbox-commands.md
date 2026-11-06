---
"@opengeni/runtime": patch
---

The default sandbox images ship the general commands agents reach for without checking first. Both images add `bunx` (Bun under that name), GNU `time`, `zip`, iproute2 (`ss`, `ip`), binutils (`strings`), `bc` and `patch`; the headless image also gains npm and npx from its pinned Node release, plus `file`, `xxd`, netcat and net-tools, which the desktop image already had. Each image now ends its build by checking the full default command list (`docker/check-default-commands.sh`), so a missing command fails the build.
