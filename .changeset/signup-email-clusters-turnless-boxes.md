---
"@opengeni/db": patch
"@opengeni/config": patch
---

New self-serve organizations (first and additional) start held when they arrive as a farm (rule `email-cluster-v1`, migration 1489), with a mode per leg in the signup network velocity settings:

- Burst (`burstMode`, enforce): four setups within ten seconds through the same shared relay, or with the same mail domain group and the same signup network. Bursts that share only a network, or only a company or academic domain (a workshop, classroom or office onboarding), and bursts of unrelated domains are only observed.
- Denied domain (`deniedDomainMode`, enforce): two denied organizations in the last 30 days on the same company or personal-relay domain; an academic domain is only observed.
- Domain (`emailDomainMode`, observe): three owners with one company or personal-relay domain within an hour.

Per-person subdomains of addy.io, anonaddy, 33mail and dynamic DNS hosts (DuckDNS, No-IP, Dynu, FreeDDNS and similar) group on the full subdomain; a burst through one such provider counts like one shared relay, and one denied organization on such a name holds the next.

Only a keyed hash of the domain is stored. Public providers and shared relays (Apple private relay, DuckDuckGo, Firefox Relay, SimpleLogin) never group on the domain or denied legs, academic domains never group on the domain leg, and reserved test domains never count.

An unpaid organization in its first day in which no turn was ever started gets 15 box-minutes (`youngTurnlessBoxSeconds` in `OPENGENI_SANDBOX_FLEET_LIMITS_JSON`). Past it, the reaper drains a box no turn holds once nothing on it was active for `youngTurnlessIdleMs` (5 minutes; `compute_turnless`). Running commands and Browser/ComputerSessions are never cut off. A box that is not running does not start again without a turn (`young_turnless`), and starting a chat always works and lifts the bound.
