---
"@opengeni/react": patch
---

The app no longer reads the workspace GitHub status for a member whose grant lacks `github:use`; it shows no GitHub state instead of a failed 403 request.
