---
"@opengeni/react": patch
---

`AutomationsPanel` is a styled root of its own, so `compiled.css` styles it in any host. Its menus, pickers and delete confirmation open in a layer of their own under `<body>` that carries the panel's theme, so a host's dialog neither unstyles nor clips them. Inside an app that already provides an overlay container, they open there. The list's loading note and the delete button's pending label come from the messages catalog (`list.loading`, `automations.panel.deleting`).
