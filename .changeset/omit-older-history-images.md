---
"@opengeni/worker-bundle": patch
---

Older images no longer ride along in every model request. When a turn attempt starts, tool-result images older than the newest three are replaced, five at a time, by a short note, one per tool result. For `view_image` the note names the path to view again; for other tools it asks for a fresh screenshot or observation instead of repeating an action. The model keeps three to seven recent images with their pixels when an attempt starts, plus any it adds during the attempt. The note is fixed for the whole attempt and the omitted set only grows, so the provider's prompt cache stays valid between batches. Stored history is unchanged, omitted images are not read from storage, and user attachments and native `computer_call_result` screenshots are not affected.
