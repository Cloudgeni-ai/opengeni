---
"@opengeni/react": patch
---

Chat timelines no longer show web-search citation handles that cannot be resolved. Besides complete handles, they now hide file citations, handles a model wrote as plain text (`citeturn0search1turn1view0`), a handle still streaming at the end of an answer, and stray delimiter characters from a handle cut short. Ordinary words such as "cite" and "excited" are untouched.
