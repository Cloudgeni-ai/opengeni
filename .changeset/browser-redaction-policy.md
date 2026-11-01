---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/observability": patch
---

Every way an agent reads a page now withholds the same things. An observation showed the text of private and payment elements, the value of a private text area and the options of a card-expiry select, while a page read withheld exactly that text. Observations now find the page's protected elements the way page reads do and show each protected field as present, labelled and fillable, with its value, options, checked state and description withheld; protected text elsewhere is withheld too, and names or descriptions built from it (a button's contents, aria-labelledby, aria-describedby) keep only their public part. A payment-like id or name (card number, CVC, expiry) marks only a form field, so ordinary page text such as a heading with id="credit-card-offers" stays readable; an action on a protected field names it by its label, never its value. A page read no longer returns text the page does not show, such as the inside of a closed details element. A connected machine that does not answer a request in time now says whether the request may have run or was never sent, and a read says it is safe to retry; a missing controller and missing screen access say how to recover, and a controller that stops while a browser or computer is opening says to open it once more. A read the controller gave up retrying keeps the driver's error class and function in the caller's logs.
