---
"@opengeni/browserd": patch
---

`check` now works on whatever observe shows as a checkbox, switch or radio button. A located element stands for the control it is or sits in, and a label (or text in it) stands for its own control, or else for the one checkable control it wraps, such as a box drawn with an ARIA role or a hidden input beside the label's box. ARIA roles and `aria-checked` are read in any case, a checkable role after one the browser does not know counts, and a custom element that sets its role and state through `ElementInternals` is read from the accessibility tree. A target that is none of these is refused with a reason that says to click it instead.
