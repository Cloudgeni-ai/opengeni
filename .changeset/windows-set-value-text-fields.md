---
"@opengeni/browserd": patch
---

Windows computer use now reports CUA's text-only value-pattern refusal as definitely not dispatched, rather than an unknown outcome, and tells the agent to click into the field and type instead. CUA does not expose the selected element's native control identity, so browserd does not bypass that refusal by guessing a control from its rectangle. This also avoids unverified password writes and casing-based guesses about masked contents. Classic Notepad fields refused by CUA still require the click-and-type path; successful CUA value writes are unchanged. A window's title bar no longer offers `set_value`, since its value is its title and cannot be set.
