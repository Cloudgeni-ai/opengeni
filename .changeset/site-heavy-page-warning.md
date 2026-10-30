---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Agents hear when a Site's page is too heavy. `artifacts_create` and `artifacts_publish` still publish any page, but when its HTML is over 5 MB the result now lists a `page_heavy` warning (or `page_too_large` over the 256 MB the Sites gateway serves) that says how large the page is and to move images and video into Site files or link them. The Sites Skill no longer suggests embedding images as data URLs beyond small icons and logos, and explains how to load media from Site files instead.
