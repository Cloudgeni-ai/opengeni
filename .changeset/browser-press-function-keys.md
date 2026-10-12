---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Browser press accepts the function keys F1-F24 and the navigation keys Home, End, PageUp, PageDown, Insert and ContextMenu, plus the common short spellings (Esc, Return, Del, PgUp, PgDn, Up, Down, Left, Right). Before, any of these was refused as an unsupported key even though the tool schema accepts any key string, so an agent could not, for example, press F2 to edit a grid cell. Genuinely unknown keys are still refused before focus moves or any input is sent. The browser action tool description now lists the accepted key names.
