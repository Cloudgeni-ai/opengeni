---
"@opengeni/react": patch
---

`@opengeni/react/composer` now exports `PauseButtonSlot`. Place it at the end of `Composer.Controls` in a custom composer: while nothing is working and Pause is hidden, it keeps Pause's room in the row, so controls such as the model picker keep one width instead of jumping each time Pause comes and goes.
