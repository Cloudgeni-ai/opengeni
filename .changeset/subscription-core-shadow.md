---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Compare the shared subscription core with the legacy Codex, Claude and SuperGrok
account selection on every subscription turn. A legacy adapter that issues
only reads builds the core's placement world from today's tables under the
turn's own session access, and the worker records content-free metrics: security parity of the
legacy account, the reference checker's violations of the core's decision,
would-switch, and the legacy decision inputs. The comparison runs in the
background (at most two at once per worker), fails open, is bounded by
`OPENGENI_SUBSCRIPTION_CORE_SHADOW_TIMEOUT_MS` (default 250 ms, at most
1000 ms), is on by default and can be turned off with
`OPENGENI_SUBSCRIPTION_CORE_SHADOW_ENABLED=false`. Placement is unchanged; no
migration is required.
