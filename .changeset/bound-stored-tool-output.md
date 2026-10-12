---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Tool-call output events are now bounded when stored. An output up to 256 KB is kept exactly; a larger one (for example a shell command that printed a multi-megabyte line) is stored as a head-and-tail preview with explicit truncation metadata, which the timeline already shows. Model history is unaffected. Full-mode history reads also return any older event larger than 4 MB as an explicit preview built in the database, so opening a chat can no longer load an enormous row into the API.
