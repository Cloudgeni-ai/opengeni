---
"@opengeni/browserd": patch
---

A browser action that starts a page navigation, such as submitting a sign-in form or following a link, now returns the page it led to. Before, a form post often returned the page it left, so the agent had to observe again. The wait is bounded, and a navigation that produces no new document (a 204 answer or a download) ends the wait as soon as the frame stops loading.
