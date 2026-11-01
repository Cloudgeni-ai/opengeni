---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Agents hear when a Site's page is too heavy. `artifacts_create` and `artifacts_publish` still publish any page, but when its HTML is over 5 MB the result now lists a `page_heavy` warning (or `page_too_large` over the 256 MB the Sites gateway serves) that says how large the page is and to compress images and link video or large media instead of embedding them. The Sites Skill no longer suggests embedding images as data URLs beyond small icons and logos, asks for pages under 5 MB, and explains when Site files can hold media (signed-in audiences only).
