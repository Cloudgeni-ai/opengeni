---
"@opengeni/react": patch
---

In the macOS app, the top bar and the sidebar now form one window surface, so the traffic lights no longer sit in an empty strip of their own. The sidebar toggle moves into that bar, beside the traffic lights. The main pane sits on the window as an inset, rounded panel. Full-window Sites and the maximized workspace use the same panel. The web app, Windows and Linux are unchanged.

For hosts: the rail's sidebar toggle renders into `[data-window-bar-controls]` when the page runs in the macOS app. The session rail carries `data-shell-rail`.
