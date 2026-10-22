---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Browser actions with a role, label, text, placeholder, test id or CSS locator now wait up to 10 seconds for their element to appear, and input actions wait while the element is disabled. One browser_act batch can therefore open a record, wait for its form and save it across page changes. browser_act's description tells agents to do a repeated procedure's later records as one batch each, or as a Code Mode loop.
