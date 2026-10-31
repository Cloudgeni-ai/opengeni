---
"@opengeni/runtime": patch
---

The agent's Skill index lists every installed Skill instead of dropping the ones that sort last once it reaches 32 KB or 128 entries. The bound is now 96 KB with no entry limit. Entries show an id only when two Skills share a name, which makes a complete index of a typical workspace smaller than the old truncated one. Above the bound, only the longest descriptions are shortened so every Skill stays listed; entries are omitted only if the names alone overflow. `skillCatalogEntryIds(catalog, descriptors)` resolves name-only entries through the descriptors the index was rendered from and still reads indexes rendered before this change.
