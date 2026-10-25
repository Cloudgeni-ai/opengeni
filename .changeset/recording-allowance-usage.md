---
"@opengeni/db": patch
---

Meeting transcripts and live previews now count toward usage allowances that opt into `unbilledUsage: "list_price"`, like model calls that spend no credits. Each completed transcript version counts its recorded provider cost once against the workspace and the person who asked for it, and a live preview counts its cost against the recording's owner as it grows. When the allowance is used up, creating a recording, re-running a transcript and starting a live preview are refused with `402 allowance_exhausted`. Dictations are not counted twice: they are paid for with credits, and that debit already counts.
