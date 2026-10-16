---
"@opengeni/runtime": patch
---

Connected-app tools no longer start with an account line when the turn has only one account for that app. The line ("Account: … Use only this account …") was added to every tool of every connected account, which repeated the same text across hundreds of tools and gave the model nothing to choose between. It now appears only when the same app has several accounts in the turn, where it tells them apart.
