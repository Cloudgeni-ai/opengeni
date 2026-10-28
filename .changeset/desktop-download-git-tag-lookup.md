---
"@opengeni/api-router": patch
---

Desktop download links (`/desktop/latest/<file>` and `/desktop/latest`) keep working when GitHub's REST API rate limit is used up. The server now lists the `desktop-v` tags over Git's smart HTTP protocol, the way `git ls-remote` does, which is not counted against the REST API's 60 requests an hour per IP address. The REST API remains a fallback. Previously, a server that shared its outbound address with other GitHub API callers could answer every desktop download with 503.
