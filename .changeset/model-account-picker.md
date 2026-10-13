---
"@opengeni/react": minor
---

Add `useSessionModelAccount`, a provider-neutral hook for a session's model account: the shared accounts and the caller's own personal accounts it may use, choosing one (or automatic selection), and the caller's personal-fallback opt-in. The web app's session header shows the matching account menu for subscription models on the shared subscription core; Codex keeps its existing menu for now.

Provider-qualified choices and Automatic preserve other providers' bindings. The menu shows stored usage without duplicating the selected account's top summary. Personal fallback is configured separately in Models settings, not in the account dropdown. `ModelPolicyPicker` supports model-identity-only policies with `allowModelOptions={false}`.
