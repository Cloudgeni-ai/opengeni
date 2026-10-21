---
"@opengeni/db": patch
---

A subscription connection quarantined after a 403 is available again as soon as its quarantine ends. Before, only a turn could clear it, so until some turn on that account happened to run, new sessions on its models were refused with "model is not available", the account picker listed it as inactive, and a person whose only personal connection was quarantined could not start the turn that would recover it. Admission, the model catalog and the account lists now read an ended quarantine as active; turns still recover the stored row before they place.
