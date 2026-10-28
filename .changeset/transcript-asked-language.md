---
"@opengeni/core": patch
---

A transcript asked for in one language is listed in that language only. A model that labels a few phrases with a neighbouring language (Danish phrases in Norwegian speech) no longer adds it to the transcript's languages; Norwegian Bokmål, Nynorsk and Norwegian count as one. Without a language asked for, every language heard is still listed. `transcriptLanguages(requested, heard)` is exported from `@opengeni/core`.
