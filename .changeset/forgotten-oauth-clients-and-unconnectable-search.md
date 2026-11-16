---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Connecting an integration no longer gets stuck on a sign-in client the provider has forgotten. Opengeni reuses the OAuth client it registered with a provider such as Supabase, and when that provider has since deleted it, Connect ended on the provider's "Unrecognized client_id" page every time. Opengeni now checks that the provider still knows the client before reusing it, and registers a new one when the provider says it doesn't.

A connection this deployment can't connect, because the provider only accepts apps it has approved (Dropbox, for one) and no client is registered with it here, now shows up when you search Capabilities for it. It's marked Unavailable and its page says why, instead of the search saying nothing matches. Other listings of the same provider, such as a server a plugin brings, are marked the same way and no longer offer a Connect that can't finish, and a provider that refuses to let apps register now gets a plain explanation instead of "dynamic client registration failed with HTTP 403".
