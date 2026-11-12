---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/api-router": patch
---

The console now sends a strict, enforced Content-Security-Policy: `default-src 'self'`, scripts only from the console and the exact hashes of its inline bootstrap scripts, `object-src 'none'`, restricted `base-uri` and `form-action`, `<style>` elements only with a per-response nonce (stamped by a hashed bootstrap script) and inline style attributes only through `style-src-attr`, and exact hosts (never `*` or a bare scheme) for storage, analytics, sign-in avatars, catalog logos, Turnstile and the Sites frame host, read from the deployment's API configuration (`GET /v1/config/content-security`). Office add-in pages get the same policy with Office's framing hosts and script hosts.

Agent-authored HTML (chat visualizations, HTML artifacts and Sites in the console) now renders in an opaque-origin sandboxed frame of a small frame-host page (`https://og.<sites domain>/_og/html-frame`, served by the Sites gateway, or `/_og/html-frame` on the console without a Sites domain) instead of a `srcdoc` frame, so it keeps running under its own policy with the same sandbox flags. `@opengeni/contracts/html-frame-host` exports the frame-host protocol; `@opengeni/react/artifacts` exports `configureContentHosting`, `ContentHostingConfig`, `displayImageSrc`, `useDisplayImageSrc` and `setImageProxyTicket`. Without configuration, embedders keep the previous `srcdoc` frames and direct image URLs.

Images from origins the policy does not list load through the new signed-in image proxy (`GET /v1/image-proxy?url=`), which fetches only public HTTPS raster images with SSRF protection on every redirect, a size cap and a deadline, and answers them inert (SVG only under a sandbox policy). The Excel add-in, which signs in with a bearer token, appends a short-lived signed ticket from `GET /v1/image-proxy/ticket`. The GitHub connection pages allow form submissions to redirect to `https://github.com`. The API's own HTML pages (GitHub connection, MCP OAuth consent and admin-consent pages) now allow their inline scripts and styles by hash instead of `'unsafe-inline'`.
