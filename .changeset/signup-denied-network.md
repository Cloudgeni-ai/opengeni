---
"@opengeni/db": patch
---

Free-credit farm protection by known bad network. A new owner-only setting, `deniedNetworkMode` (`off` by default; `observe` or `enforce`), holds the Free credit of a new self-serve owner whose exact network (IPv4 address or IPv6 /64) was used in the last 90 days by an account with a denied decision or a currently held account, through its signup or its owner's sign-ins, even when it is the only signup from that network. /24 and /48 prefixes never trigger it, invited members never count, manual decisions and operator releases are kept, and failures fail open. Sign-in networks are stored only as HMAC-SHA256 values under a random per-schema database key; the migration captures them for accounts already denied or held. `scripts/operator/promotion-decisions.ts` adds `--denied-network-mode` and `--rule`, and `--network-holds` lists these holds with their own reason. See `docs/signup-abuse-protection.md`.
