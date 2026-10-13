---
"@opengeni/core": patch
---

Keep Codex models selectable with unknown readiness when an eligible account's
catalog cannot be read, instead of letting another account's smaller plan veto
the pool. Actual placement continues to check the selected account's authority
and entitlement. Align legacy-retirement tests and accepted-policy fixtures with
the shared runtime, without restoring removed decision paths.
