---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Sidebar layouts keep what a newer version wrote: options, layout fields and the layout version a replica doesn't know stay in storage through its writes (only Reset clears them), and answers carry only the options it knows, so API replicas of different versions no longer drop each other's saved options during a rolling deploy. The rail draws the sidebar options this browser last saw while the layout loads, so the Sessions list no longer draws app rows and then redraws without them; the shell slot `sessionsShowApps` accepts `null` for "not known yet", which holds the Sessions list on its loading state. A settings rail entry's button now reads **Move to More** or **Show at top** on hover instead of an unlabeled arrow.
