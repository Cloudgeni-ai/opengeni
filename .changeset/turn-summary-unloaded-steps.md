---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

Turn summary facets now learn when they see only part of a turn. `TurnSummaryContext.unloadedSteps` is true when some of the turn's steps are not loaded: before the turn is opened, until its earlier pages are read, and on a long live turn whose collapsed row keeps only its newest steps. A count over `items` or `toolCalls` is then too low and can go down while the turn runs, so a facet can omit it or show it as a lower bound. The signal reaches every turn row, in both the readable and the classic presentation, on web and React Native. `@opengeni/react/timeline-model` adds the helpers that renderers use for it: `timelineTurnsWithUnloadedSteps`, `activityHasUnloadedSteps` and `turnGroupHasUnloadedSteps`.
