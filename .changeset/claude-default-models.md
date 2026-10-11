---
"@opengeni/config": patch
"@opengeni/db": patch
---

Connecting a Claude account now adds Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 by default, instead of starting with no models. This only happens where no Claude model of that kind was ever configured, so existing and trimmed lists are kept. Claude Haiku 5.5 is also offered among the Claude models you can add, and a rolling migration adds it where Claude models are already in use and Haiku 5.5 was never added or removed.
