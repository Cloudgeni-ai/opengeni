---
"@opengeni/db": patch
"@opengeni/api-router": patch
"opengeni-web": patch
---

Free-credit farm protection by signup network. Each new self-serve organization records keyed hashes of the owner's client (IPv4 address or IPv6 /64) and its /24 or /48 prefix (never the address itself, kept 90 days), in every mode; invited members are never recorded. A new owner-only, revision-fenced setting (`off` by default) can observe or enforce an IP-velocity rule that holds Free credit, not access or purchased funds, from the 3rd new organization from one address within 24 hours, and can refuse organization setup with HTTP 429 after 5 from one address in an hour. The onboarding screen shows the server's message for that refusal. `scripts/operator/promotion-decisions.ts` adds `--network-velocity`, `--network-velocity-set`, `--network-holds` and `--network-release-holds`. See `docs/signup-abuse-protection.md`.
