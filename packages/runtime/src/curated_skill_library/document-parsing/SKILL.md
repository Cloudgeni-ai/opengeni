---
name: document-parsing
description: Extract readable Markdown from local Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF files using the preinstalled AnyDoc runtime.
license: MIT
metadata:
  runtime: anydoc@0.1.8
  upstream: https://github.com/firecrawl/anydoc
---

# Parse local documents

Use the preinstalled `anydoc` CLI when a task needs the contents of a local
office document, ebook, CSV, or text-based PDF. This is read-only extraction;
it does not edit the source or replace OpenGeni's durable artifact tools.

```bash
anydoc report.docx
anydoc slides.pptx -o /tmp/slides.md
anydoc - --format csv < data-without-extension
```

Rules:

1. Supported inputs: `.doc`, `.docx`, `.docm`, `.odt`, `.rtf`, `.epub`,
   `.pdf`, `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`,
   `.odp`, `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.ods`, and `.csv`.
2. Let AnyDoc detect the format from file content. Specify `--format` only for
   signature-less input such as CSV on stdin or a file without a useful name.
3. For large output, use `-o` and inspect only the relevant sections instead
   of streaming the whole document into model context.
4. Preserve the source file. AnyDoc output is a derived reading aid, not a new
   canonical document or editable artifact.
5. Scanned/image-only PDFs need OCR and are unsupported. Encrypted, malformed,
   or resource-limit failures must be reported rather than guessed around.
6. Never install or download AnyDoc at runtime. If `anydoc` is unavailable,
   report that the selected compute image lacks the parsing runtime.
