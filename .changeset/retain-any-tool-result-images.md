---
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Images returned by any tool, such as an integration's capture tool, are now kept the same way as viewed images and screenshots: stored once in object storage with a compact reference in session history, instead of base64 inside each history row. The timeline shows them as images, and the model receives the same image bytes, in the same form, as before. Each image in a result is stored separately, and an image that cannot be stored stays inline exactly as today. Only new tool results change; existing history is untouched. Stored tool images follow the existing screenshot retention period and workspace quota.
