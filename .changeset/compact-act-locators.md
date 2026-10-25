---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

browser_act and computer_act accept `role:name` as a bare locator string (`"link:Sign in"`, `"push button:Save"`), meaning the element with that role and exact name, next to a bare element ref. In browser_act, `label:` and `placeholder:` name those locator kinds instead. computer_act actions may also leave out `type`: an action with a locator is semantic and one with actions is a batch. Exact names now compare whole names in any case and spacing, the same way in the browser and in computer readings. A repeated form fill needs about a third fewer output tokens per record.
