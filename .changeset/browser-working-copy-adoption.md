---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/db": patch
"@opengeni/api-router": minor
---

Browsers: a browser whose working directory was copied or restored (for example after a machine's disk was replaced) can now be continued from that copy instead of staying unavailable. `inspectBrowserSessionWorkingCopy` reports why the copy is refused and, when it can be adopted, the exact digest of its bytes; `adoptBrowserSessionWorkingCopy` adopts exactly those bytes under the browser's existing control authority, and `getBrowserSessionWorkingCopyAdoption` reports an adoption's recorded outcome, without changing it, when a reply was lost; retrying the same adoption settles one that stopped part way and never repeats a step. How recent the copy is stays explicitly unknown. Only controller-owned derived entries are left out of the copy, and inspection lists them. An adopted copy is never replaced by an older checkpoint afterwards, the directory it replaced is kept, and every step is journaled so a crash at any point is finished or reported, never guessed. Supported on Linux machines only for now. When a preserved browser is refused, its error now says why and what to do next.
