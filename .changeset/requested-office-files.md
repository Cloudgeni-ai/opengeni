---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agents now edit a Word, Excel, PDF or PowerPoint file the user sends to be changed directly in the sandbox with ordinary tools (python-docx, openpyxl, pandoc, LibreOffice), check it and publish it, and make a newly requested file in such a format the same way unless the artifact export tool lists that format. Before, an agent asked for a Word or Excel file built a native artifact and then reported that export was unavailable, and a sent file the document importer could not read was returned unchanged.
