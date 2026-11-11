---
"@opengeni/codex": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A Codex model gated above the client version Opengeni presents no longer strands turns. The version refusal ("requires a newer version of Codex") now fails the turn with `codex_client_version_rejected` and is never treated as a plan refusal, even when it carries an upgrade code. When the backend hides a model from every connected account's live model list, home-provider placement no longer waits behind another account's unrelated quota reset: it runs on capacity, and the provider's answer decides. Nothing is written against the account, so service returns as soon as the presented version is new enough.
