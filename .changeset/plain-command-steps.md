---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

Command steps in a chat's activity read as what they did in plain words ("Downloaded email-review.json", "Read report.md", "Ran make_chart.py", or the tool an `ogtool call` ran, such as "Search messages") instead of the raw `$ command`. The full command stays one click away, at the top of the step's output. Signed and token-bearing links (storage signatures such as `sig=` or `X-Amz-Signature=`, and `token=`-style parameters) never show their query as text, in commands, command output or tool payloads. `@opengeni/react/timeline-model` exports `commandStepTitle` and `redactSignedUrls`, and the English catalog gains the `timeline.commandStep.*` keys. Plain tool details are unchanged.
