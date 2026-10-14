---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/config": minor
---

Sites can now save data. Every published Site gets persistent collections of JSON records and files that survive new versions: Site code uses `site.data` (list, get, insert, put, patch with conflict detection, delete, increment, count, batch) and `site.files` (upload, list, url, delete) from `createOpenGeniSiteClient()`, with no credentials in the Site. Each collection's access mode decides what viewers may do (shared, shared read, per viewer, append only), enforced by the server; the Site page itself always acts as a viewer, and an Only me Site's data stays its owner's. Agents and scheduled tasks manage data with new `site_data_*` and `site_files_*` tools, and the Site page has a Data tab for the people who manage the Site. Quotas, write limits, per-Site and per-workspace limits on schema-checking time, and usage metering (usage only, no charge yet) apply. Hosts opt in by giving `createSiteToolBridge` a pinned Site and `fetchResponse`; older hosts report `site_data_unsupported`.
