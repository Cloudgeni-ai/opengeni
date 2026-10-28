---
"@opengeni/react": patch
---

In the macOS app, the top bar and the sidebar now form one window surface, so the traffic lights no longer sit in an empty strip of their own. The sidebar toggle moves into that bar, beside the traffic lights. The main pane sits on the window as an inset, rounded panel. Full-window Sites and the maximized workspace use the same panel. The web app, Windows and Linux are unchanged.

For hosts: only inside the Opengeni macOS app, the rail's sidebar toggle renders into `[data-window-bar-controls]`, in a host at the start of the body. The session rail carries `data-shell-rail`, and while a full-window artifact, Site or workspace is open the document root carries `data-window-layer-open`.
