---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/interaction": patch
"@opengeni/sdk": patch
---

Browser navigation now completes only once the new page has committed, and a page that never stops making requests no longer counts as network idle. Before, `navigate` could return while the tab still showed the previous page, so the next action could find and press its element in the page being left, and `waitUntil: 'network_idle'` reported success after waiting out its full timeout on pages that poll continuously. Now navigate and history steps wait for their own commit (and stop a navigation that never commits), and the outline, URL and screenshot of a result always describe the same document. A network-idle wait on a page that loaded but never went quiet still ends at its timeout and lets the batch carry on, and the action receipt now says so in a new per-action `notes` entry (`kind: "network_busy"`) instead of implying an idle network; a page that never loaded still fails the wait. When the page moves to a new document after an action found its element and just before its first input event, the action looks for its element (named by role, text or another non-ref locator) once more on the new page within its own deadline, and is refused without input only if the element is not there or the page changes again; actions in a fenceEachAction batch, and actions still waiting for their element, keep acting only on their own document as before. A navigation the browser turns into a download ends at once.

A server that answers with an HTTP error status and no body is now treated like one that sends an error page: the tab shows the browser's page naming the status, and navigate, tab open and browser open complete on it. A browser whose first page fails to load still opens and shows the browser's error page instead of failing the whole open, with a plain line naming the load error, and a navigation that fails to load reports its failure with the error page the tab actually committed.
