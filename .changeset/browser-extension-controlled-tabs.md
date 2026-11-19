---
"@opengeni/browser-extension": minor
---

In a person's own connected Chrome, the tabs an agent is controlling now sit in a blue tab group named "Opengeni" and show a cursor in place of the site's icon, so the tab strip shows which tabs are in use. Shortly after control ends, a tab gets its own icon back and returns to where it was, or to the person's own group it came from, including after the extension updates or reloads. A tab the person drags out of the group stays out until that control ends. Page titles and content are not changed; pages the extension cannot script, such as Chrome's own pages, keep their icon. The extension now asks for Chrome's `tabGroups` permission, which shows no warning, and needs Chrome 130 or later.
