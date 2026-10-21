---
"@opengeni/runtime": patch
---

Share one Modal client per credential across sandbox creates and resumes, and cache the Modal app and image lookups, so creating a sandbox no longer pays a fresh auth handshake and three lookup round trips, and reattaching a warm sandbox no longer builds a new client.
