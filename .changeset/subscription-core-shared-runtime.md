---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
---

Run the shared subscription runtime as one provider-neutral implementation. Placement, leases, credential loading and refresh, health, request reservation and waiter cleanup now live in shared modules that take the provider as data, and Codex plugs in through a small adapter. Codex behaves exactly as before and every existing function keeps its name. A check fails if a shared module names a provider or branches on one.
