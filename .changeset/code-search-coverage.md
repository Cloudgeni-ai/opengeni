---
"@opengeni/jev": minor
---

`code_search` now aims to cut irrelevant reading without hiding relevant code. It follows the identifiers of the relevant files to their definitions and usages, including files no keyword matched. It judges every function of small relevant files, checks call sites of the definitions it follows, and refills the budget when its evidence rating is low. Each pack ends with a map of the relevant files that names the line ranges and declarations it did not show. It also reports every limit that cut something, and keywords that matched nothing (or only irrelevant files) together with similar identifiers that exist in the workspace.
