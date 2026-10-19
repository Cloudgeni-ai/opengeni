---
"@opengeni/api-router": patch
---

Computer screenshots from adapters that only produce PNG (such as the Windows CUA adapter) no longer fail on large, photographic windows. When a PNG frame exceeds the model image size limit, the API re-encodes the same pixels as JPEG, keeping the frame's identity and dimensions so pointer coordinates stay valid, before falling back to a smaller capture. If nothing fits, the request now fails with a clear, non-retryable error instead of "temporarily unavailable".
