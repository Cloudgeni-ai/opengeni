---
"@opengeni/browserd": patch
---

On macOS, computer use can now fill a web page's date, time, month, week and date-time fields with one `set_value` in ISO form (for example `2027-03-07` or `2027-03-07T14:05`). The field's parts are typed one by one in the page's own order and the field is checked afterwards. Acting on a single part now points to the field and the form it takes, instead of saying the part cannot take the keyboard focus. Batches whose actions add up to more than 64 steps now run in several calls.
