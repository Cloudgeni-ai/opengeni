---
"@opengeni/browser-extension": minor
---

In a person's own connected Chrome, a tab an agent is controlling now shows the Opengeni icon in place of the site's icon, so the tab strip shows which tabs are in use. The site's own icon comes back shortly after control ends, including after the extension updates or reloads. Page titles and content are not changed. Pages the extension cannot script, such as Chrome's own pages, keep their icon. Branded builds may add a `tab-mark.png` to their icons folder; `brand:icons` now makes one.
