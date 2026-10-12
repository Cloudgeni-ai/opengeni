---
"@opengeni/react": minor
---

Add `useSessionModelAccount`, a provider-neutral hook for a session's model account: the shared accounts and the caller's own personal accounts it may use, choosing one (or automatic selection), and the caller's personal-fallback opt-in. The web app's session header shows the matching account menu for subscription models on the shared subscription core; Codex keeps its existing menu for now.
