---
"@opengeni/runtime": minor
---

browser_act accepts `includeScreenshot: true` and then returns a still image of the tab after the action in the same call, so screenshot-driven flows no longer need a separate browser_screenshot call after every action. A failed capture keeps the action's receipt and says why the image is missing.

An upload action also accepts `paths` of files in the session's workspace. The tool publishes each path the same way sandbox_file_publish does and uploads the resulting files, so a file the agent just wrote no longer needs a separate publish call (and a tool search to find it) before the upload. `workspaceFileIds` keep working unchanged.
