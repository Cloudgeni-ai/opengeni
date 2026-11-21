---
"@opengeni/browserd": patch
---

A computer-use batch that fills a field and then presses a button or key now checks the field before that press. Before, a text, number or date field, a checkbox or a switch was only checked when nothing that could submit the form came after it in the batch, so "fill the email, press Continue" went ahead even when the app had thrown the value away. Safari does this on React sign-in forms. The batch now reads the window right before the first press or key that follows such a write. If the write did not take, the batch stops there with "Action N of the batch ran, but the text field … still reads …. The batch stopped there", and the press is never sent. If it took, the remaining steps continue on the same elements in the new reading. A checkbox or switch is now also checked when only other fields are filled after it.
