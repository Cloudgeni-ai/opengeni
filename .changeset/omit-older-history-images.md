---
"@opengeni/worker-bundle": patch
---

Older images no longer ride along in every model request. When a turn starts, tool-result images older than the newest three are replaced, three at a time, by a short note that says how to see them again (for `view_image`, the path to view; for other tools, the tool to call again). The model keeps three to five recent images with their pixels. The note is fixed for the whole turn and the omitted set only grows, so the provider's prompt cache stays valid between batches. Stored history is unchanged, omitted images are not read from storage, and computer-call screenshots and user attachments are not affected.
