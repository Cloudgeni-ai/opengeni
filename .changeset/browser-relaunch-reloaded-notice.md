---
"@opengeni/contracts": minor
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/codemode": patch
---

A managed browser that was stopped (for example after going unused for 10 minutes) and relaunched now says so on the tabs it reopened. Chrome reopens those tabs at the same URLs and they keep their IDs, but each page loaded again, so text typed into it, a dialog it had open and anything else it held only in memory are gone. Before, nothing said this: an agent that came back to the tab saw an emptied page with no explanation, and an action it had chosen for the page as it was ran on the reloaded one.

The first observation of a reopened tab that reaches the caller (browser_observe, or the page after a browser_act) now carries a new optional `notice` field on `BrowserObservation`, shown to the model right after the tab line, for example: "This browser was stopped after going unused for 10 minutes and relaunched on its next call, so this tab's page reloaded: anything typed, selected or opened on it before then that the page did not save is gone." It is given once. An action on the page's content that comes before any such observation is refused with `target_stale` and nothing is sent to the page; its message says the same and asks to observe the tab first. Navigation, history, activate, viewport, permission and wait actions still run.

A tab showing the browser's error page (its last load failed) now also keeps its ID across a relaunch. Chrome reopens such a tab at the address it failed to load, not at its error page, so browserd now records and matches it under that address, read from the tab's history when the browser stops. Before, the tab was reported as replaced and reappeared under a new ID. Tab lists still show the error page's URL while the tab shows it.
