"""Build-time proof that the stock sandbox images can make Office and PDF files.

Run by the shared agent Python toolchain block in docker/sandbox.Dockerfile and
docker/desktop.Dockerfile. It writes one real file per format with the
preinstalled libraries, reads each back with an independent reader, and fails
the image build if any library is missing or produces an unreadable file.
"""

import sys
import tempfile
from pathlib import Path

import docx
import openpyxl
import pptx
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

TEXT = "Opengeni export smoke"


def check(ok: bool, what: str) -> None:
    # Not `assert`: python -O would skip it and let a broken image through.
    if not ok:
        raise SystemExit(f"office export smoke failed: {what}")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)

        document = docx.Document()
        document.add_heading(TEXT, level=1)
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "score"
        table.rows[0].cells[1].text = "92"
        document.save(out / "smoke.docx")
        reread = docx.Document(out / "smoke.docx")
        check(reread.paragraphs[0].text == TEXT, "docx heading")
        check(reread.tables[0].rows[0].cells[1].text == "92", "docx table")

        workbook = openpyxl.Workbook()
        workbook.active.append([TEXT, 92])
        workbook.save(out / "smoke.xlsx")
        sheet = openpyxl.load_workbook(out / "smoke.xlsx").active
        check(sheet["A1"].value == TEXT and sheet["B1"].value == 92, "xlsx cells")

        deck = pptx.Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[0])
        slide.shapes.title.text = TEXT
        deck.save(out / "smoke.pptx")
        title = pptx.Presentation(out / "smoke.pptx").slides[0].shapes.title.text
        check(title == TEXT, "pptx title")

        pdf = canvas.Canvas(str(out / "smoke.pdf"), pagesize=A4)
        pdf.drawString(72, 760, TEXT)
        pdf.save()
        check(TEXT in PdfReader(out / "smoke.pdf").pages[0].extract_text(), "pdf text")

    print("office export smoke: docx xlsx pptx pdf ok", file=sys.stderr)


if __name__ == "__main__":
    main()
