---
"@opengeni/browserd": patch
---

An accessibility state too long to keep whole now ends in "…". A state holds at most 128 characters, and a longer one, such as the `url=` of a page or link with a long address, was cut without any mark. It then looked like a complete value, and a cut address copied from it led to a page that does not exist. The page's exact address stays available from the tab's own metadata.
