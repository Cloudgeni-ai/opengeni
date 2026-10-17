---
"@opengeni/runtime": patch
---

Desktop screenshots from `computer_observe` and the native CUA tools are re-encoded from PNG to JPEG (quality 85, full chroma) once, before the model or screenshot retention sees them. Pixel dimensions are unchanged, so coordinates stay exact; a capture that would not get smaller stays PNG. This makes each retained desktop screenshot about three times smaller, so workspace screenshot storage lasts its full retention period.
