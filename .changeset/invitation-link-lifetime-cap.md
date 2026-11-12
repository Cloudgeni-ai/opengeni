---
"@opengeni/db": patch
---

Organization invitations, and the account setup links sent with them, now last at most 48 hours. A request for a longer lifetime is capped at 48 hours after creation instead of refused, and the response returns the stored expiry. Invitations that already exist keep their expiry. The web app now asks for 48 hours instead of 7 days.
