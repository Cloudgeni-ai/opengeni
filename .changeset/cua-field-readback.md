---
"@opengeni/browserd": patch
---

Computer use on macOS fills web form fields more reliably. `set_value` on a text field with a value that reads as a number (a card's CVC, a postcode) now writes it as text: Chrome used to accept the number and leave the field empty while the action reported success. A text field that still reads its old value after `set_value` now fails with "the app did not take the value; invoke the field and type the text instead". A web date field Chrome leaves without a value of its own now reads the value its day, month and year parts show, so a correctly filled date is no longer reported as "reads empty". When every action of a batch ran but a field check failed, the error says "All N actions of the batch ran, but …" instead of reporting later actions as not run.
