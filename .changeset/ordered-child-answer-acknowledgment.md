---
"@opengeni/db": patch
---

Take the canonical session/cursor/turn/attempt lock prefix when acknowledging a consumed child answer, preventing the imported-archive turn guard from deadlocking parallel tool-result writers and lifecycle transactions. Preserve best-effort acknowledgment, exact-attempt checks, and duplicate-read no-ops without replaying tools.