---
"@opengeni/react": minor
---

`RelativeTime` and the time formatting functions now take their words from the message catalog (`time.*` keys), so a host that supplies `messages` and a `locale` gets translated relative times ("Just now", "48 min ago", "Yesterday"), absolute times, dates, weekday and month names and time zone labels. The component reads the nearest messages provider. `formatRelativeTime`, `formatAbsoluteTime`, `formatDate`, `formatShortTime` and `formatExactTime` accept `text` in their options, and `timeZoneLabel` and `inSentence` accept it as a second argument; all stay English when it is omitted. English output is unchanged.
