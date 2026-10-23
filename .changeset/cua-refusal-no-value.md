---
"@opengeni/browserd": patch
---

On macOS a `set_value` that CUA refuses because the value is outside a control's range, or because stepping stopped short of it, no longer repeats the value in its message, since it may be a secret such as a PIN in a number field.
