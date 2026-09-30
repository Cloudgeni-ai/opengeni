---
"@opengeni/api-router": patch
---

A non-UUID resource id in the URL path (for example a newer SDK calling
`GET .../scheduled-tasks/attention` against a server without that route, which
falls through to `.../scheduled-tasks/:taskId`) now answers 404
`invalid_path_identifier` instead of an unhandled 500. Malformed UUIDs that do
not come from the request path stay server errors.
