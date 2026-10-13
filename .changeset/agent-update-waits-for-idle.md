---
"@opengeni/browserd": patch
"@opengeni/interaction": patch
---

A requested agent update on a busy machine now waits for the machine to become idle instead of failing with `update_busy_work`. The agent accepts the update, reports it as waiting for idle (with the reason), keeps admitting new work, and re-attempts its short idle proof every few seconds until it can apply. Open browser and computer sessions no longer count as busy when a restart would lose nothing: a quiescent managed browser whose owned process survives graceful shutdown and is reattached on its next request, a session whose browser already ended, and a computer session on the machine's own physical seat. Admitted commands, attached browser sessions, browsers without a durable working runtime and isolated virtual desktops still keep the update waiting.
