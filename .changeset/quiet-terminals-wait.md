---
"@opengeni/react": patch
---

Buffer early ttyd terminal input until a supported sandbox's Bash Readline readiness signal. Keep old images explicitly legacy and offer a deliberate manual-input escape that clears buffered typing for startup prompts or unsupported shells. The guarantee requires the matching sandbox image; existing daemons are not restarted. Relay PTY behavior is unchanged.
