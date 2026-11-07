---
"@opengeni/react": minor
---

The composer can keep images where they were added. With the new opt-in `imageTags` prop on `ChatComposer` (also `useChatComposerController` and `SessionConversation`'s `composerProps`), pasting, dropping or attaching an image puts a plain-text `[Image N]` tag in the text at the cursor, and the image's chip shows "Image N". Removing an image removes its tag and renumbers the later ones; images restored with a draft or a recalled queued message keep the tags their text already has, and new images are numbered after them. Image N is the Nth image the message carries, the order the agent receives them, so the message and API are unchanged. Off by default. `FileAttachment` gains `restored` for files brought back with a draft, and `useFileAttachments` gains an optional `loadFileContentType`.
