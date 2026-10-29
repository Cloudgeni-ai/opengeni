---
"@opengeni/browserd": patch
---

A click in a tab that is open in the background keeps its protection against landing on something else. Chrome can take seconds to acknowledge the pointer's move in a tab it is not drawing, and the guard that holds back a press landing on anything other than the target disarmed itself on a clock that started before that move. By the time the press arrived the guard was off: a layer that the pointer's arrival opened over the target took the click, and a submit click whose page was replaced before the driver read the guard back was reported as an unknown outcome although it reached its button. The guard's clock now restarts just before the press.
