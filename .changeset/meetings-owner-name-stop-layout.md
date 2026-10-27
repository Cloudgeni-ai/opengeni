---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Meetings name the person recording in apps whose users Opengeni has no name for, leave the call's echo out of the live text, and show a stopped meeting's tabs right away.

- `POST /v1/workspaces/{workspaceId}/recordings` takes an optional `ownerName`. With computer or tab audio beside the microphone, the microphone is the person recording; when Opengeni has no name for them (an app's own users usually have none), this name adds them to the speaker directory, so the transcript's microphone reads their name instead of "Microphone". A name Opengeni already has, and a person already in the directory, stay as they are. `createBrowserRecorder` and `useRecorder` take `ownerName` and send it only for such recordings; the React recorder panel sends its `viewerName`.
- The live transcript no longer repeats the others in a call under the person recording's name when they have no headphones. A microphone line is left out when at least two of its words, and 70% of them, were heard in computer audio within two seconds. `withoutLiveMicrophoneEchoes` is exported from `@opengeni/react/recordings`, and `LiveTranscript` takes the recording's `tracks` to apply it.
- After Stop, the meeting page switches to Summary, Transcript and Notepad (with Ask) at once. It stayed in the recording layout until a reload while the recorder still held its live text.
