---
"@opengeni/config": patch
"@opengeni/api-router": patch
---

Installing or updating the Connected Machine agent no longer leaves a machine worse off. Both installers stage the new binary and refuse one that cannot start on the machine (exit code 8, naming its exit code, for example `0xC0000135` STATUS_DLL_NOT_FOUND on Windows) before it replaces a working agent, and report a refused machine connection as exit code 9 with the agent's exit code, leaving the running agent untouched. On Windows, an upgrade whose new agent then fails to start in the background restores and restarts the previous agent. The agent's own Windows self-update now checks the staged binary before the swap, as on Linux and macOS. Windows machines report real CPU, memory and disk metrics instead of zeros. `OPENGENI_AGENT_STABLE_VERSION` is now optional: unset, `/agent/latest/*`, the stable update manifest and automatic updates use the agent release of the control plane's own source tree (`agent/Cargo.toml`) instead of the fixed, long-outdated `0.1.54`; an API that cannot name a release answers 404 and requests no updates.
