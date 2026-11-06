---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Attached images always show as images. A draft restored after a reload or opened on another device, a queued message, and a sent message viewed elsewhere now load their pictures from the server instead of showing a generic file chip, on web and native. Every surface reads previews the same way through the new `useStoredFiles`, `useStoredFilePreview` and `readStoredFilePreviewUrl` helpers, which share one signed URL per file until shortly before it expires and re-sign once when an image stops loading.
