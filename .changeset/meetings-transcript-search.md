---
"@opengeni/db": patch
---

Searching meetings (`query` on the recordings list) now finds transcript words while they're still being typed: every word of the query matches as the start of a word, in any order, so "onboard" finds "onboarding". A corrected segment is found by its corrected words and no longer by the ones it replaced. Titles still match any part of the title.
