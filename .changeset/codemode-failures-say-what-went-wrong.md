---
"@opengeni/worker-bundle": patch
"@opengeni/ogtool": patch
---

A Code Mode call that fails after it started still settles as an unknown outcome, but it now keeps the error the Opengeni API (or the SDK's transport check) reported, with its reference, instead of only the generic text. A browser action or tab change that the API answers with an error therefore says what went wrong from Code Mode too, as a direct call does. Other thrown errors keep the generic text. `ogtool call --save-image` (and the native `codemode call`) print an error result as the call's answer instead of reporting a completed call whose image could not be saved.
