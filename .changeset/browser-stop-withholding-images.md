---
"@opengeni/browserd": patch
---

Browser screenshots, live views and recordings are no longer refused after a tab shows a card field or a known card number; they work on every page. The native agent no longer refuses an attached-Chrome extension that does not advertise the payment-privacy capability, and a frame whose field snapshot fails (such as an older extension that cannot take one) is read without it instead of the read failing.

Card fields are now only the ones a page marks with the standard `autocomplete` tokens (`cc-number`, `cc-csc`, `cc-exp` and the other `cc-*` tokens), which checkouts and payment widgets set so browsers can autofill them. Ids, names, placeholders and labels that merely look like payment words (`card-number`, `cvc`, `expiry`) no longer hide a field. Password fields, including text fields named or labelled as a password, and fields a page marks hidden or private are unchanged.

A fill now confirms in any field that holds the same digits with grouping the page added as they were typed (card, phone and account numbers), not only in card fields. Changed digits still leave the fill uncertain.
