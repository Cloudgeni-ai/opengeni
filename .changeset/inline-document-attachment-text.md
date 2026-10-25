---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
---

A model can now answer about an attached document in one step. The text of a PDF with a text layer, a Word, PowerPoint, Excel or OpenDocument file, or a CSV or other text file is shown to the model in the message that carries it, up to 64,000 characters per message, with the start of larger documents and a note to read the file for the rest. Before, the model first read the document-parsing Skill and ran a parser in the sandbox, two extra model round trips. The text is extracted once in the worker when the message is first rendered and stored, so later requests replay the same bytes and keep the prompt cache. Messages sent before this change are unchanged. The retry notice for an unreadable attachment now says "file" instead of "image".
