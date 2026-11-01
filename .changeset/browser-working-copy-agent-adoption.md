---
"@opengeni/runtime": patch
---

An agent can now recover a stopped browser whose working directory was moved, copied or restored. Before, the refusal pointed to inspectBrowserSessionWorkingCopy and adoptBrowserSessionWorkingCopy, which agents can't call. It now names the copy's size and latest checkpoint and says how to continue: call browser_open with the browser and `adoptWorkingCopy` set to the copy's exact digest, or open a new browser with mode "new". The adoption uses the browser's normal control authority. It adopts exactly those bytes and refuses if they changed. The directory it replaces is kept. Retrying the same copy settles an adoption that stopped part way, and a collision leaves the browser for a person to revert.
