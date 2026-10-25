---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": patch
"@opengeni/db": patch
---

User messages can now carry the sender's IANA time zone (`timeZone`) on `user.message` events, steer requests, composer submits and the initial message of a new session. The server validates the name, freezes it with the accepted turn, and the agent sees the sender's local time first, for example `[Message sent Sunday 2026-10-25 09:08 Europe/Oslo (08:08 UTC) by Ada]`. Messages without a zone render exactly as before.

The SDK client fills the zone automatically on a person's device (browser, desktop app, React Native) from `Intl.DateTimeFormat().resolvedOptions().timeZone` when the caller did not pass one. Server-side callers never attach their own zone. Pass `messageTimeZone: false` in the client options to opt out. When an older server rejects the field, the client retries the message once without it.
