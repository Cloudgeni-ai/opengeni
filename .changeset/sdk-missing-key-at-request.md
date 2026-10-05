---
"@opengeni/sdk": patch
---

`new OpenGeni({ apiKey: process.env.OPENGENI_API_KEY! })` at module scope no longer breaks `next build` (or any import) where the key exists only at runtime: a missing key now fails each request with "Opengeni requires an apiKey. Set OPENGENI_API_KEY in the server environment." instead of throwing during construction. The session proxy also logs the cause of any unexpected `proxy_error` 500 on the server (the browser still gets the generic message), so host configuration mistakes are no longer silent.
