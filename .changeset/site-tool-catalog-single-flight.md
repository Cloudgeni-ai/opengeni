---
"@opengeni/sdk": patch
---

Workspace tools and the host Site tool bridge now share one in-flight catalog request across concurrent callers. A caller's abort cancels only its own wait, failed loads are not cached, and calls rejected on the same stale digest share one post-rejection refresh. Site calls checked against an unchanged catalog entry may now succeed from an older catalog digest; the API echoes that digest.
