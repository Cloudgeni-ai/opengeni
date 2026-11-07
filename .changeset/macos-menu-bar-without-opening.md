---
"@opengeni/browserd": patch
---

A macOS menu-bar item ("File", "View") is no longer pressed open by a computer action. A menu opened that way in an app in the background stayed open out of sight and held every click and key in that app until it closed. set_value on the menu-bar item with an item's name ("Zoom In", or "Submenu > Item") now chooses the item straight from the menu bar without opening a menu; invoke and show_menu on it open nothing and say how to choose an item.
