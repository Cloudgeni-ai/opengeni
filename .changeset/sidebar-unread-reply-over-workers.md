---
"@opengeni/react": patch
---

A chat whose agent has replied shows the unread dot in the sidebar even while its sub-sessions are still working or it waits on them, instead of a spinner or hourglass that hid the reply. The dot's label keeps the work ("1 unread · 2 working"), and expanded worker rows keep their own spinners. The chat's own running turn keeps its spinner. Anything that needs you, a failure or an unsent message still comes first; the command menu and Control+Tab switcher show the same marker.
