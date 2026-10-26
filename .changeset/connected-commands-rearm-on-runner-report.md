---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

A background command on a Connected Machine no longer stays "running" forever after the machine was offline. When the reconciler could not reach the machine, it left the command to the machine's own reports, but the machine reports only operations it knows, so a command whose start never reached it was never settled. Now the machine's next inventory report makes those commands due again; the reconciler asks the machine, and one it does not know settles lost (never as a success), while one it runs continues as before. Migration 0984 adds the private function behind this and makes commands already stuck this way due once. Compute sandboxes are unaffected: their running commands are still never polled.
