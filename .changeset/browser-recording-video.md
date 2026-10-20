---
"@opengeni/browserd": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
"@opengeni/react": patch
---

Agents can record a browser flow as a video. The new `browser_record` tool starts a recording of a managed or attached browser tab and stops it into an MP4 in the chat's workspace, with a log of when each action happened beside it, and publishes the MP4 so it plays in the chat. Frames are captured only when the page changes, so recording costs almost nothing while a page is still, and the video is encoded on the server, so browser hosts need no video encoder. The SDK adds `startBrowserRecording`, `getBrowserRecording` and `saveBrowserRecording`.
