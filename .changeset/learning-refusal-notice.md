---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": patch
"@opengeni/api-router": patch
---

When an agent's Skill, workspace instruction or Knowledge save is refused, the chat now tells the person. A "Not saved to Skills" (or workspace instructions, or Knowledge) row appears beside the agent's reply and stays visible when the turn folds. It appears only for genuine refusals: Agent learning is off where the change would be saved, the chat isn't allowed to make the change, or the agent was started from a Site page. It says why in plain words and links to Agent learning settings or the item. Mistakes the agent can correct and retry itself, such as citing evidence the destination's readers can't see, show no row. Previously a refusal was visible only inside the folded tool call, so a request to remember something could be lost silently.

The refusal travels as a content-free `_meta["opengeni/learningRefusal"]` fact on the tool result (destination, reason and the targeted Skill ID only), which the model never sees. New exports: `learningRefusalFromToolOutput` and the `LearningRefusal` type from `@opengeni/sdk/learning-refusal`; the full fact from `@opengeni/contracts/learning-refusal`; and `LearningRefusalActionsProvider` and `LearningRefusalPlace` from `@opengeni/react`, which let a host open the right page. `NoticeItem` gains an optional `learningRefusal`.
