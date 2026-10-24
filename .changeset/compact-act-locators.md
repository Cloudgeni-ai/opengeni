---
"@opengeni/runtime": patch
---

browser_act and computer_act accept `role:name` as a bare locator string (`"link:Sign in"`), meaning the element with that role and exact name, next to a bare element ref. computer_act actions may also leave out `type`: an action with a locator is semantic and one with actions is a batch. A repeated form fill needs about a third fewer output tokens per record.
