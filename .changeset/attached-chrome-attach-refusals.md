---
"@opengeni/browserd": patch
---

Attached Chrome now reports a tab that Chrome will not let the browser extension debug as a definite failure that says why and what to do, instead of a retryable "browser observation unavailable" that reached agents as "The workspace is temporarily unavailable — retry." The common case is a sign-in page where a password manager has added its inline-menu frame: older extensions relay Chrome's raw refusal, which now becomes guidance to update the extension, turn off that inline menu for the site, or use a managed browser; newer extensions' own explanation is kept word for word. Any other refusal names Chrome's reason, bounded to 300 bytes, and a tab that is gone is `target_not_found`. Lost connections and timeouts stay retryable.
