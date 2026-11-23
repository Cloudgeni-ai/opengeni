---
"@opengeni/browser-extension": patch
---

Chrome no longer turns the extension off when it updates. Version 0.3.0 began requiring Chrome's `tabGroups` permission. Chrome shows a warning for that permission ("View and manage your tab groups"), and it turns an extension off after any update that adds a required permission with a warning, until the person accepts it. So every Chrome that updated from 0.2.x had the extension switched off and stopped connecting. `tabGroups` is now optional. Chrome turns the extension back on by itself once this version installs, and nothing needs to be accepted. Tabs an agent controls still show the cursor icon. A new "Tab group for agent tabs" switch in the extension menu also puts them in the grey group, and Chrome asks the person to confirm. Anyone who already accepted the permission keeps the group without doing anything.
