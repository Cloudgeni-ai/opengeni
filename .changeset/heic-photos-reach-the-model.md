---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

HEIC/HEIF photos (the iPhone camera format) now reach the model as an image. No model provider accepts HEIC, so an attached iPhone photo used to arrive as a file reference only and the agent had to convert it in its sandbox before it could look at it. The worker now decodes HEIC/HEIF attachments with libheif (WebAssembly) and shows them to the model as a JPEG, downscaled to the message's image bound like any other photo, with a note that the file itself is the original HEIC. This works for every upload path, including untyped `.heic` uploads, which qualify by their bytes. Messages are stamped with the converted formats when they are accepted, so images in earlier requests never change; older messages keep their reference-only receipt. `view_image` in the sandbox now converts HEIC/HEIF files the same way instead of answering that they are not a supported image.
