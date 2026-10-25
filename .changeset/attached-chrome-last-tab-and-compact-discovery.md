---
"@opengeni/browser-extension": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Closing the last tab of an attached Chrome profile no longer disconnects the profile. Chrome closes a profile with its last window, which stopped the extension and ended the profile's connection while Chrome kept running; the extension now opens a new tab page in that window before closing the profile's only tab. A new tab in a Chrome that is running with no window open (common on macOS) opens in a new unfocused window instead of failing. A tab close whose profile connection ends before the extension answers is reported as `outcome_unknown` (HTTP 409) telling the agent to list the tabs again, instead of an unexpected internal error, and a tab Chrome says is already gone is `target_not_found`. `interaction_discover` now shows the model a compact inventory: each BrowserSession and ComputerSession keeps what is needed to reuse it (id, name, lifecycle, placement, engine or platform, identity, last use, whether it belongs to this chat and the capabilities it lacks), and at most 50 sessions and identities of each kind, this chat's own first and then usable ones by most recent use, with a note naming how many were left out. A large workspace used to produce a result of megabytes that the model could not read. Code Mode programs still receive every full record.
