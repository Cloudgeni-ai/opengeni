---
"@opengeni/browserd": patch
---

Browser clicks now reach buttons built as web components, where the real button sits in a shadow root and its label is slotted in from the page (common in design systems such as Microsoft's admin portals). Before, the click check saw the component's outer element at the button's centre and refused with "browser element is covered by …", even though nothing covered it. The check now follows the same tree that pointer events travel, so slotted labels and shadow content count as part of their button, while a real layer over such a button is still refused and named.
