---
"@opengeni/runtime": patch
---

The stock sandbox and desktop images now also include `reportlab` and `pypdf`, so agents can make and edit PDF files as well as Word, Excel and PowerPoint files without installing anything. Each image build now writes and reads back a real .docx, .xlsx, .pptx and .pdf and fails if any of them can't be made. The bundled documents Skill lists `pypdf` and tells the agent to install a missing package and continue on an import or missing dependency error.
