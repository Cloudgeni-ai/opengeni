---
"@opengeni/capabilities": patch
"@opengeni/runtime": patch
---

Generated OpenAPI integrations now read files whose download redirects. A safe read (GET or HEAD) follows at most three https redirects, such as Microsoft Graph `/content` to its pre-signed download URL, through the same pinned transport and one shared deadline, without the Authorization header, credential cookies or credential query parameters. A redirect target's own 401 or 403 (an expired link) is returned as the provider's result rather than as a lost authorization. A mutation's redirect is still rejected and its outcome stays unknown. Response bytes that are not UTF-8 (PDFs, images, Word, Excel and PowerPoint files) come back as base64 instead of replacement characters, up to 2 MiB; larger binary reports its size. A body over the response limit is a recoverable `response_too_large` error.

A generated integration call that fails with a known outcome (a rejected redirect, a missing path parameter, an authorization the provider refused) now reaches the model as an ordinary tool error, `{"ok":false,"error":{"code","message","status","retryable"}}`, on every server. It is no longer reported as a tool that is unavailable for the rest of the turn. A missing path parameter's error names the parameter.
