---
"@opengeni/contracts": patch
"@opengeni/api-router": patch
---

`scrubClientErrorText` now runs in time linear in its input. URL query and fragment removal matches each whole URL and cuts the query in the replacement, and JWT redaction skips candidates that cannot complete, so long runs of URL or JWT prefixes no longer make the scrubber rescan the rest of the text from every prefix. The output is unchanged. The client error beacon route also refuses a diagnostic field longer than twice its projected bound before scrubbing it.
