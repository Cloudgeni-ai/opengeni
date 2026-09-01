---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/github": minor
"@opengeni/sdk": minor
---

Add authenticated, bounded GitHub branch suggestions for exact workspace App
repositories and exact selected personal OAuth repositories, including shared
contracts and typed SDK methods. Recheck repository authority around provider
requests, keep provider credentials server-side, and preserve arbitrary refs at
the session resource boundary. Add lazy branch pickers, verified public GitHub
URL attachment, explicit anonymous-clone warnings for other HTTPS hosts,
render-safe manual drafts, idempotent unlink reconciliation, and debounced live
repository refreshes across new and existing sessions.