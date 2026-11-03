---
"@opengeni/runtime": patch
---

Tool search now reads tool names that run words together, as generated OpenAPI tools named from lowercased operationIds do (`me_createmessages`, `sites_listlists`, `drives_getitemscontent`). A run-together name word is split into the operation verbs and words the tool's own description and parameters use, so "create a draft message" or "list the lists on a site" reaches the matching tool and its operation is recognised. A word the tool uses whole, in any inflection, is not split, every split needs a piece from the tool's own words, and the exact run-together name still matches. Names whose words are already separated rank as before.
