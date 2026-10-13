---
"@opengeni/api-router": patch
---

Remove LibreOffice, OCR language data and the unused native Documents parser
closure from the API image. Documents uploads continue to index on the existing
control worker, whose converter dependencies are unchanged. Keep FFmpeg local to
voice transcription and fonts available for native artifact rendering; no new
process or network hop is introduced.
