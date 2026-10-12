---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Admin access for a session now has a time limit. It lasts one hour by default; the person giving it can choose 8 hours, a day or no limit, and can change the limit while it is on. Access ends by itself when the time is up. `PUT .../admin-access` accepts `{ durationHours }` (1 to 720, or null for no limit), and `SessionAdminAccess` reports `expiresAt`.
