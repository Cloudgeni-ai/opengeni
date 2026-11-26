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
        assert reread.paragraphs[0].text == TEXT
        assert reread.tables[0].rows[0].cells[1].text == "92"

        workbook = openpyxl.Workbook()
        workbook.active.append([TEXT, 92])
        workbook.save(out / "smoke.xlsx")
        sheet = openpyxl.load_workbook(out / "smoke.xlsx").active
        assert sheet["A1"].value == TEXT and sheet["B1"].value == 92

        deck = pptx.Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[0])
        slide.shapes.title.text = TEXT
        deck.save(out / "smoke.pptx")
        assert pptx.Presentation(out / "smoke.pptx").slides[0].shapes.title.text == TEXT

        pdf = canvas.Canvas(str(out / "smoke.pdf"), pagesize=A4)
        pdf.drawString(72, 760, TEXT)
        pdf.save()
        assert TEXT in PdfReader(out / "smoke.pdf").pages[0].extract_text()

    print("office export smoke: docx xlsx pptx pdf ok", file=sys.stderr)


if __name__ == "__main__":
    main()
