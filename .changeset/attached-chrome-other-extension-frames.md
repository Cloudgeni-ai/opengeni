---
"@opengeni/browser-extension": patch
"@opengeni/browserd": patch
---

Attached Chrome no longer loses a tab when another extension puts its own frame in the page, as password managers do for their inline menus. Chrome ends and refuses debugging of a tab that holds another extension's page, so the extension now removes those frames from tabs it controls (including inside closed shadow roots) and attaches again, using the new `scripting` permission with access to all sites; Chrome's permission warnings are unchanged because the debugger permission already covers all sites. When the page keeps adding the frame back, the tab fails with a clear error that names the password manager and says to turn off its inline menu for the site or use a managed browser. Each attachment now has a number, so a late command for an ended attachment is refused instead of reaching its replacement and a detach reported after its replacement attached no longer ends it; input that Chrome ends part way is reported as outcome unknown without making the tab unusable, and the extension accepts `Inspector.enable`, which browserd sends on every attach.
