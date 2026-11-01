---
"@opengeni/browserd": patch
---

A text field that a page names or labels as a password is now protected like `<input type=password>`, whatever its type. Sites that show a stored password in an ordinary text input labelled "Password" no longer have its value printed in semantic outlines, DOM reads or clipboard copies, and the value is remembered for redaction elsewhere. A field counts when its name, id, `aria-label`, placeholder, `<label for>`, wrapping `<label>` or `aria-labelledby` text, or its accessible name (shadow roots and custom elements included) calls it a password, in English and common European languages. Checkboxes and buttons such as "Show password", and "passwordless" fields, are not affected.
