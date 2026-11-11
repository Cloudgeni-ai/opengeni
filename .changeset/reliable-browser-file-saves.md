---
"@opengeni/react": patch
---

Saving a file from the browser works reliably in Firefox. Downloading a retained artifact, downloading a published file from the chat timeline, exporting an editable spreadsheet, document or presentation, exporting Site data and exporting an agent now share one save step that attaches the download link to the page for the click and keeps the file's object URL alive for 60 seconds. Before, most of these paths revoked the URL right after the click, and Firefox could fail the download even though the file had been fetched in full.
