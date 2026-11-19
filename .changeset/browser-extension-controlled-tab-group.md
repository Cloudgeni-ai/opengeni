---
"@opengeni/browser-extension": minor
---

In a person's own connected Chrome, the tabs an agent is controlling now sit in a tab group named "Opengeni", one per window, so the tab strip shows which tabs are in use without changing the pages, their titles or their icons. A tab leaves the group shortly after control ends; a tab the agent took over goes back to where it was, or to the person's own group it came from. A tab the person drags out of the group stays out until that control ends. Tabs still grouped when the extension updates go back where they were, and groups left behind when Chrome restarts are removed; the person's own groups are left alone. The extension now asks for Chrome's `tabGroups` permission, which shows no warning.
