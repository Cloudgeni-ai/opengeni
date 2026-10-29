---
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/runtime": patch
---

Agents can offer options as an interactive answer. An `opengeni-ui` fence holds one JSON object with the options, the fields to compare, an optional chart field and whether the person may pick; the conversation draws it as cards, a sortable table (web) and a bar chart, with filter chips, the best value per field marked, and a pick bar that sends the choice as the person's next message. The answer grows in place while it streams and stays read only in ended sessions. `InteractiveAnswer`, `InteractiveAnswerProvider` and `browserInteractiveAnswerStore` are exported from `@opengeni/react`, the renderer-neutral model from `@opengeni/react/interactive-answer-model`, and `NativeSessionScreen` accepts an `answerStore`. The bundled `visualize` Skill describes the fence.
