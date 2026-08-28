---
"@opengeni/api-router": patch
"@opengeni/documents": patch
"@opengeni/worker-bundle": patch
---

Make common Documents uploads reliable by replacing ImageMagick-dependent image conversion, shipping Office conversion and local OCR prerequisites in the stock workloads, recognizing ordinary text files with generic MIME types, and surfacing indexing failures during upload.