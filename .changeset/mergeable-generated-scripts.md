---
---

CI: the generated Site browser runtime, the Site gateway shell script and the API's action schema imports are now written one statement or name per line, with the bundled scripts' names kept. Two PRs that change different SDK code no longer conflict in these files, so the merge queue stops ejecting every other SDK PR each time one lands. The shipped runtime behaves the same; it is about 9 KB larger compressed.
