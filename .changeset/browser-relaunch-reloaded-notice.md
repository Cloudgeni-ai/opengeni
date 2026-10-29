---
"@opengeni/contracts": minor
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/api-router": patch
---

A managed browser that was stopped (for example after going unused for 10 minutes) and relaunched now tells the agent so on the tabs it reopened. Chrome reopens those tabs at the same URLs and they keep their IDs, but each page loaded again, so text typed into it, a dialog it had open and anything else it held only in memory are gone. Before, nothing said this: an agent that came back to the tab saw an emptied page with no explanation.

The first observation of a reopened tab that the agent's own tools receive (browser_observe, the page after a browser_act, or a tab selected with browser_tabs) now carries a new optional `notice` field on `BrowserObservation`, shown to the model right after the tab line, for example: "This browser was stopped after going unused for 10 minutes and relaunched on its next call, so this tab's page reloaded: anything typed, selected or opened on it before then that the page did not save is gone." It is given once. Nothing is refused because of it: an element reference from before the reload already fails as stale, and anything else the agent does runs on the page as it now is, with the notice in the result. A caller receives notices only when it asks with the new `notices=1` query parameter (`BROWSER_OBSERVATION_NOTICES_PARAMETER`), which the API sends only for an agent's own requests, so a person watching the browser, an auth check or an API client neither sees the notice nor uses it up. Browser controllers that predate it ignore the parameter, and callers that do not send it never receive the field.

Every tab a relaunched browser reopened now answers. Chrome loads the pages of only the first few tabs it restores and leaves the rest without a renderer until they are used, which browserd reported as "This browser tab crashed", so with five or more tabs the later ones could not be used after a relaunch. browserd now starts such a tab's page the first time it is used, in the background and without switching to it, and waits briefly for it to load.

A tab showing the browser's error page (its last load failed) now also keeps its ID across a relaunch. Chrome reopens such a tab at the address it failed to load, not at its error page, so browserd now records and matches it under that address, read from the tab's history when the browser stops. Before, the tab was reported as replaced and reappeared under a new ID. Tab lists still show the error page's URL while the tab shows it.
