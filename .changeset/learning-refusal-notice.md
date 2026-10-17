---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": patch
"@opengeni/api-router": patch
---

When an agent tries to save a Skill, workspace instruction or Knowledge change and it is refused, the chat now tells the person. A "Not saved to Skills" (or workspace instructions, or Knowledge) row appears beside the agent's reply and stays visible when the turn folds, says why in plain words (for example, a chat that saves what it learns only for you can't change a Skill shared with the workspace, or Agent learning is off), and links to where the change can still be made. Previously the refusal was visible only inside the folded tool call, so a request to remember something could be lost silently.

The refusal travels as a content-free `_meta["opengeni/learningRefusal"]` fact on the tool result (destination, reason and the targeted Skill ID only), which the model never sees. New exports: `@opengeni/sdk/learning-refusal` and `@opengeni/contracts/learning-refusal` (`learningRefusalFromToolOutput`, `LEARNING_REFUSAL_META_KEY`, types), and `LearningRefusalRow`, `LearningRefusalActionsProvider` and `LearningRefusalPlace` from `@opengeni/react` (`LearningRefusalActionsProvider` lets a host open the right page). `NoticeItem` gains an optional `learningRefusal`.
