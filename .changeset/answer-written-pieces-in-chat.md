---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agents answer requested briefs, letters, plans and reports in chat, and create a document only when the person asks for a document or file (for example a DOCX or PDF), asks to edit an existing document, or the result is too long to read comfortably in chat. Before, "clearly meant to be kept or shared" let an agent turn a request like "write a one-page project brief" into a document: about 80 seconds and several document tool calls instead of a 15-second chat answer, with only a link left in the conversation.
