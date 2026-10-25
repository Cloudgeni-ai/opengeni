---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

An agent's browser recording is now a recording, so it is stored, owned, shared and deleted like any other. Saving one makes a recording whose purpose is `browser`, with one video track from the browser tab whose chunk is the frame bundle the browser host uploads. The worker encodes the MP4 and its action log in the background instead of the API encoding it inside the save request, then the save copies both into the chat's files and publishes the video as before. While the video is being made, the save answers 202 with `state: "encoding"`, and the SDK keeps repeating it as it does while uploading. The recording follows the chat: a private chat's recording is its owner's and private; a shared chat's belongs to the person the agent acts for. Meeting lists show meetings only, and browser recordings have no transcripts. A recording's tracks now say their `kind` (`audio` or `video`) and, for a video, its size and frame count; a recording says its `purpose` and, if its video failed, an `errorCode`. Migration 0945 adds the columns.
