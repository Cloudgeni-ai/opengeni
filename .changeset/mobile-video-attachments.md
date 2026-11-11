---
"@opengeni/sdk": minor
"@opengeni/react-native": minor
"@opengeni/react": patch
---

Videos can be attached from a phone. The Expo photo library offers photos and videos, and the camera records video as well as taking photos (iOS; Android's camera stays a photo camera). Library videos keep their original file, so nothing is re-encoded before sending. The composer shows a video as a tile with its length and the upload's percentage, and a sent video shows in the timeline as a video chip that opens in the system player. The agent receives it in its sandbox like a file uploaded on the web.

Every picked file now uploads straight from disk through Expo's native upload task, which reports progress and keeps going while the app is in the background, so a long video never has to be read into memory. Files up to 20 MiB are still hashed on the device; larger ones upload without a client digest, as a plain REST upload does. Removing an attachment, or leaving the chat, stops its upload. Hosts with their own adapters can opt in through the new optional `NativeFileAdapter.uploadSource`; without it files are read into memory as before.

`uploadFile` in the SDK accepts a `FileUploadSource` as `data` (`{ sizeBytes, send(target) }`) for callers that send the bytes themselves, and an optional `signal` that cancels the upload.
