---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A question card with one question now says "Send answer" instead of "Send answers", on the web and on the phone. `HumanInputFormMessages` gains an optional `submitOne` label for that case. A host that sets its own `submit` label keeps it for single questions too unless it also sets `submitOne`.
