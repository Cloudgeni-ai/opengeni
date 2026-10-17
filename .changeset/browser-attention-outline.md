---
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/browserd": patch
---

Lead the compact browser outline with what needs attention on dense pages. An opened menu, dialog, listbox or tooltip, live messages such as toasts, and the focused or acted-on element with its small enclosing group now come first, the page's own content next, and site navigation last; empty live regions are left out. The omitted-element note names the largest regions it left out. A role or text locator that matches several elements now picks the single one whose whole name is the requested text, and an ambiguous locator lists its candidates with refs. A covered target names the element on top of it, and a failed step in a batch says which step failed.
