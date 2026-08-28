#!/usr/bin/env python3
"""Render the governed internal AI applications product-direction one-pager."""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "opengeni-internal-ai-applications-one-pager.pdf"
LOGO = ROOT / "apps" / "web" / "public" / "favicon.svg"

PAGE_W, PAGE_H = landscape(A4)

BG = HexColor("#202228")
SURFACE = HexColor("#292C34")
SURFACE_2 = HexColor("#31353E")
BORDER = HexColor("#464B56")
FG = HexColor("#F3F5F8")
MUTED = HexColor("#B4BAC5")
SUBTLE = HexColor("#8D95A2")
ACCENT = HexColor("#5893EA")
ACCENT_DEEP = HexColor("#316FD0")
ACCENT_SOFT = HexColor("#253E61")
GREEN = HexColor("#66C89A")
GOLD = HexColor("#D7B663")
PURPLE = HexColor("#B590DF")


def paragraph_style(
    name: str,
    size: float,
    leading: float,
    color=FG,
    font: str = "Helvetica",
    alignment: int = TA_LEFT,
) -> ParagraphStyle:
    return ParagraphStyle(
        name,
        fontName=font,
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=alignment,
        spaceAfter=0,
        spaceBefore=0,
        allowWidows=0,
        allowOrphans=0,
    )


BODY = paragraph_style("body", 8.2, 11.2, MUTED)
BODY_SMALL = paragraph_style("body-small", 7.3, 9.7, MUTED)
BODY_BRIGHT = paragraph_style("body-bright", 8.2, 11.2, FG)
CARD_TITLE = paragraph_style("card-title", 9.4, 11, FG, "Helvetica-Bold")
SECTION = paragraph_style("section", 10.5, 12.5, FG, "Helvetica-Bold")


def draw_paragraph(
    c: canvas.Canvas,
    html: str,
    x: float,
    y_top: float,
    width: float,
    height: float,
    style: ParagraphStyle = BODY,
) -> float:
    paragraph = Paragraph(html, style)
    _, used_height = paragraph.wrap(width, height)
    paragraph.drawOn(c, x, y_top - used_height)
    return used_height


def rounded_box(
    c: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    fill=SURFACE,
    stroke=BORDER,
    radius: float = 10,
) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.7)
    c.roundRect(x, y, width, height, radius, fill=1, stroke=1)


def chip(c: canvas.Canvas, label: str, x: float, y: float, fill, color=FG) -> float:
    font = "Helvetica-Bold"
    size = 6.6
    padding_x = 7
    width = stringWidth(label, font, size) + 2 * padding_x
    c.setFillColor(fill)
    c.setStrokeColor(fill)
    c.roundRect(x, y, width, 17, 8.5, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x + padding_x, y + 5.2, label)
    return width


def draw_logo(c: canvas.Canvas, x: float, y: float, width: float) -> None:
    drawing = svg2rlg(str(LOGO))
    if drawing is None:
        return

    def recolor(node) -> None:
        if hasattr(node, "strokeColor") and getattr(node, "strokeColor") is not None:
            node.strokeColor = ACCENT
        for child in getattr(node, "contents", []) or []:
            recolor(child)

    recolor(drawing)
    scale = width / max(drawing.width, drawing.height)
    drawing.scale(scale, scale)
    renderPDF.draw(drawing, c, x, y)


def flow_card(
    c: canvas.Canvas,
    number: int,
    title: str,
    copy: str,
    x: float,
    y: float,
    width: float,
    accent,
) -> None:
    rounded_box(c, x, y, width, 81, SURFACE, BORDER, 9)
    c.setFillColor(accent)
    c.circle(x + 17, y + 61, 8, fill=1, stroke=0)
    c.setFillColor(BG)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(x + 17, y + 58.4, str(number))
    draw_paragraph(c, title, x + 31, y + 70, width - 40, 18, CARD_TITLE)
    draw_paragraph(c, copy, x + 12, y + 43, width - 24, 32, BODY_SMALL)


def responsibility_row(
    c: canvas.Canvas,
    label: str,
    copy: str,
    x: float,
    y_top: float,
    width: float,
    accent,
) -> None:
    c.setFillColor(accent)
    c.roundRect(x, y_top - 11, 5, 5, 2.5, fill=1, stroke=0)
    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 12, y_top - 13, label)
    draw_paragraph(c, copy, x + 88, y_top - 3, width - 88, 25, BODY_SMALL)


def render() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Governed Internal AI Applications")
    c.setAuthor("OpenGeni / CloudGeni")
    c.setSubject("Product direction one-pager")

    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # Soft accent wash, echoing OpenGeni's restrained focus glow.
    c.setFillColor(HexColor("#23334B"))
    c.circle(PAGE_W - 65, PAGE_H + 8, 165, fill=1, stroke=0)
    c.setFillColor(HexColor("#252B36"))
    c.circle(PAGE_W - 8, PAGE_H - 15, 90, fill=1, stroke=0)

    margin = 36
    draw_logo(c, margin, PAGE_H - 59, 25)
    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin + 35, PAGE_H - 37, "OpenGeni")
    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 8)
    c.drawString(margin + 96, PAGE_H - 37, "x")
    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin + 107, PAGE_H - 37, "CloudGeni")
    chip(c, "PRODUCT DIRECTION", PAGE_W - margin - 94, PAGE_H - 46, ACCENT_DEEP)

    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 27)
    c.drawString(margin, PAGE_H - 93, "Build internal AI apps on internal data.")
    draw_paragraph(
        c,
        "A governed application factory for domain teams: describe what you need, bind only approved data and tools, "
        "deploy onto organization-controlled compute, and keep durable AI capabilities inside the finished app.",
        margin,
        PAGE_H - 108,
        560,
        42,
        paragraph_style("subtitle", 10.5, 14.5, MUTED),
    )
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawRightString(PAGE_W - margin, PAGE_H - 94, "Lovable-like creation")
    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 8)
    c.drawRightString(PAGE_W - margin, PAGE_H - 108, "+ enterprise data, identity, policy and operations")

    c.setStrokeColor(BORDER)
    c.setLineWidth(0.7)
    c.line(margin, PAGE_H - 142, PAGE_W - margin, PAGE_H - 142)

    # Five-stage experience.
    flow_y = 343
    gap = 10
    flow_w = (PAGE_W - 2 * margin - 4 * gap) / 5
    stages = [
        ("Describe", "Intent, users, outcomes and success criteria.", ACCENT),
        ("Bind", "Approved data, tools, models and deployment target.", PURPLE),
        ("Build", "Durable session, tests, preview and trusted OCI evidence.", GOLD),
        ("Govern + deploy", "Review access, policy, desired state and lifecycle.", GREEN),
        ("Run with native AI", "Durable agents, retrieval, reports, schedules and approvals.", ACCENT),
    ]
    for index, (title, copy, color) in enumerate(stages, start=1):
        x = margin + (index - 1) * (flow_w + gap)
        flow_card(c, index, title, copy, x, flow_y, flow_w, color)
        if index < len(stages):
            c.setStrokeColor(BORDER)
            c.setLineWidth(1)
            c.line(x + flow_w + 2, flow_y + 40.5, x + flow_w + gap - 2, flow_y + 40.5)

    c.setFillColor(SUBTLE)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(margin, flow_y + 93, "FROM INTENT TO AN AUTHENTICATED INTERNAL URL")

    # Lower-left value proposition.
    lower_y = 132
    lower_h = 176
    left_w = 303
    rounded_box(c, margin, lower_y, left_w, lower_h, SURFACE, BORDER, 11)
    draw_paragraph(c, "Why this is different", margin + 16, lower_y + lower_h - 16, left_w - 32, 20, SECTION)
    bullets = [
        ("Data stays where it belongs", "Attach in place, clone deliberately, or provision app-owned state."),
        ("Your compute, models and policies", "Local Kubernetes, private cloud or an approved enterprise environment."),
        ("AI is native to the application", "Build-time, application-time and operations-time agents share one durable runtime."),
        ("Governed by desired state", "Policy, PR review, GitOps, audit, rollback and ownership-safe teardown."),
    ]
    bullet_y = lower_y + lower_h - 47
    for title, copy in bullets:
        c.setFillColor(ACCENT)
        c.circle(margin + 20, bullet_y + 1, 2.3, fill=1, stroke=0)
        draw_paragraph(
            c,
            f"<b>{title}</b><br/><font color='#B4BAC5'>{copy}</font>",
            margin + 31,
            bullet_y + 10,
            left_w - 48,
            34,
            BODY_BRIGHT,
        )
        bullet_y -= 35

    # Lower-right responsibility split.
    right_x = margin + left_w + 12
    right_w = PAGE_W - margin - right_x
    rounded_box(c, right_x, lower_y, right_w, lower_h, SURFACE, BORDER, 11)
    draw_paragraph(c, "One platform. Clear boundaries.", right_x + 16, lower_y + lower_h - 16, right_w - 32, 20, SECTION)
    responsibility_row(
        c,
        "OpenGeni",
        "Durable build and app-agent sessions, tools, goals, approvals, schedules, events and compute.",
        right_x + 17,
        lower_y + lower_h - 43,
        right_w - 34,
        ACCENT,
    )
    responsibility_row(
        c,
        "CloudGeni",
        "Targets, desired state, infrastructure validation, policy, PR delivery, drift and lifecycle governance.",
        right_x + 17,
        lower_y + lower_h - 76,
        right_w - 34,
        PURPLE,
    )
    responsibility_row(
        c,
        "Your environment",
        "Application containers, identity, data, secrets, ingress, observability, backup and network controls.",
        right_x + 17,
        lower_y + lower_h - 109,
        right_w - 34,
        GREEN,
    )
    c.setFillColor(ACCENT_SOFT)
    c.roundRect(right_x + 16, lower_y + 11, right_w - 32, 25, 7, fill=1, stroke=0)
    draw_paragraph(
        c,
        "<b>Hard boundary:</b> agents build, test and operate the app; a durable workload serves it. "
        "A sandbox is never the production hosting plane.",
        right_x + 27,
        lower_y + 30,
        right_w - 54,
        22,
        BODY_SMALL,
    )

    # Reference story and footer.
    c.setFillColor(SURFACE_2)
    c.roundRect(margin, 63, PAGE_W - 2 * margin, 51, 10, fill=1, stroke=0)
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(margin + 16, 96, "REFERENCE EXPERIENCE")
    draw_paragraph(
        c,
        '"Create a materials explorer using the approved measurements database read-only; store derived annotations in an isolated database; '
        'let researchers ask questions, compare experiments and generate reports; expire the demo after seven days."',
        margin + 16,
        90,
        PAGE_W - 2 * margin - 32,
        30,
        paragraph_style("quote", 8.4, 11.8, FG, "Helvetica-Oblique"),
    )

    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 6.7)
    c.drawString(margin, 31, "OPEN SOURCE RUNTIME + GOVERNED INFRASTRUCTURE + ORGANIZATION-CONTROLLED DATA")
    c.drawRightString(PAGE_W - margin, 31, "opengeni.ai  /  cloudgeni.ai")

    c.showPage()
    c.save()


if __name__ == "__main__":
    render()
    print(OUTPUT)
