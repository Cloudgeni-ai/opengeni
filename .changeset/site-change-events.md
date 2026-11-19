---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/site-gateway": minor
"@opengeni/runtime": patch
---

Sites hear about data changes live (behind `OPENGENI_SITES_LIVE_ENABLED`, off by default, plus the gateway's `SITE_LIVE` Durable Object binding). Site Data writes take a per-Site change number in the write transaction and, while a page follows changes, record a small outbox row; pages connect only once their code calls `onChange`, notices are coalesced per Site, and hidden pages let the connection go; the gateway pushes `{collections, seq}` hints (never records) over a WebSocket held by a per-Site Durable Object, and Site code follows them with `site.data.onChange` / `collection.onChange`. The console's Site view uses the same connection for new versions, backs off its fallback checks while nothing changes, and makes none while hidden.

Site Data inserts accept an `idempotencyKey` (a retry returns the original record), and filters accept `$now` (server time, optionally offset) for lease expiry. Site speed is measured: per-operation API histograms with `Server-Timing`, Site SQL round trips, and sampled page timings (app load, first data, bridge calls) batched through the gateway. The sites Skill asks agents to review who sees what before publishing or sharing.
