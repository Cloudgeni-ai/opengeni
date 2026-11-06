---
"@opengeni/api-router": patch
---

Listing browsers and Desktops no longer offers one as active after its chat moved to another machine. A browser or Desktop left on a Connected Machine its chat has moved away from was only marked retired when something next opened it, so discovery listed it as reusable and opening it was then refused. The list now records the move first, shows it as lost, and ends what the move left on the former machine in the background, as opening it already did.
