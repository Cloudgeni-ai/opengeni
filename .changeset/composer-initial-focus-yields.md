---
"@opengeni/react": patch
---

Composer `autoFocus` no longer moves focus out of an open menu, listbox, or dialog when the composer becomes interactive late, so a hydrating composer cannot dismiss a menu the person just opened.
