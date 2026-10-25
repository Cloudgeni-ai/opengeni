---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Browser navigation now completes only once the new page has committed, and a page that never stops making requests no longer counts as network idle. Before, `navigate` could return while the tab still showed the previous page, so the next action could find and press its element in the page being left, and `waitUntil: 'network_idle'` reported success after waiting out its full timeout on pages that poll continuously. Now navigate and history steps wait for their own commit (and stop a navigation that never commits), a network-idle wait that times out says that the page loaded but its network never went idle, input is refused when the document changed after the action found its element, and the outline, URL and screenshot of a result always describe the same document.

A server that answers with an HTTP error status and no body is now treated like one that sends an error page: the tab shows the browser's page naming the status, and navigate, tab open and browser open complete on it. A browser whose first page fails to load still opens and shows the browser's error page instead of failing the whole open, and a navigation that fails to load reports its failure with the error page the tab actually committed.
