#!/usr/bin/env python3
"""Render the OpenGeni Sites product one-pager."""

from __future__ import annotations

from pathlib import Path

from reportlab.graphics import renderPDF
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from svglib.svglib import svg2rlg


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "opengeni-sites-one-pager.pdf"
LOGO = ROOT / "apps" / "web" / "public" / "favicon.svg"
PAGE_W, PAGE_H = landscape(A4)

BG = HexColor("#202228")
SURFACE = HexColor("#292C34")
SURFACE_2 = HexColor("#31353E")
BORDER = HexColor("#464B56")
FG = HexColor("#F3F5F8")
MUTED = HexColor("#B4BAC5")
SUBTLE = HexColor("#8D95A2")
BLUE = HexColor("#5893EA")
BLUE_DEEP = HexColor("#316FD0")
BLUE_SOFT = HexColor("#253E61")
GREEN = HexColor("#66C89A")
GREEN_SOFT = HexColor("#203F35")
PURPLE = HexColor("#B590DF")
GOLD = HexColor("#D7B663")


def style(name: str, size: float, leading: float, color=FG, font="Helvetica") -> ParagraphStyle:
    return ParagraphStyle(
        name,
        fontName=font,
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=TA_LEFT,
        spaceAfter=0,
        spaceBefore=0,
        allowWidows=0,
        allowOrphans=0,
    )


BODY = style("body", 8.1, 11.0, MUTED)
SMALL = style("small", 7.1, 9.3, MUTED)
TITLE = style("card-title", 10.0, 12.0, FG, "Helvetica-Bold")
SECTION = style("section", 10.8, 13.0, FG, "Helvetica-Bold")


def para(c, html: str, x: float, top: float, width: float, height: float, paragraph_style=BODY):
    item = Paragraph(html, paragraph_style)
    _, used = item.wrap(width, height)
    item.drawOn(c, x, top - used)
    return used


def box(c, x, y, width, height, fill=SURFACE, stroke=BORDER, radius=10):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.7)
    c.roundRect(x, y, width, height, radius, fill=1, stroke=1)


def chip(c, label: str, x: float, y: float, fill, color=FG):
    font, size, pad = "Helvetica-Bold", 6.6, 7
    width = stringWidth(label, font, size) + pad * 2
    c.setFillColor(fill)
    c.roundRect(x, y, width, 17, 8.5, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x + pad, y + 5.2, label)
    return width


def logo(c, x: float, y: float, width: float):
    drawing = svg2rlg(str(LOGO))
    if drawing is None:
        return

    def recolor(node):
        if hasattr(node, "strokeColor") and getattr(node, "strokeColor") is not None:
            node.strokeColor = BLUE
        for child in getattr(node, "contents", []) or []:
            recolor(child)

    recolor(drawing)
    scale = width / max(drawing.width, drawing.height)
    drawing.scale(scale, scale)
    renderPDF.draw(drawing, c, x, y)


def lane(c, x, y, width, title, tag, copy, accent, fill):
    box(c, x, y, width, 72, fill, accent, 11)
    chip(c, tag, x + 14, y + 43, accent, BG)
    para(c, title, x + 14, y + 36, width - 28, 20, TITLE)
    para(c, copy, x + 14, y + 18, width - 28, 22, SMALL)


def stage(c, number, title, copy, x, y, width, accent):
    box(c, x, y, width, 65, SURFACE, BORDER, 9)
    c.setFillColor(accent)
    c.circle(x + 16, y + 47, 7.5, fill=1, stroke=0)
    c.setFillColor(BG)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawCentredString(x + 16, y + 44.5, str(number))
    para(c, title, x + 29, y + 56, width - 38, 16, style(f"stage-{number}", 8.8, 10.5, FG, "Helvetica-Bold"))
    para(c, copy, x + 11, y + 34, width - 22, 28, SMALL)


def dot_row(c, x, top, width, title, copy, accent):
    c.setFillColor(accent)
    c.circle(x + 3, top - 6, 2.5, fill=1, stroke=0)
    para(c, f"<b>{title}</b> - {copy}", x + 12, top, width - 12, 24, SMALL)


def render():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("OpenGeni Sites - native internal AI apps")
    c.setAuthor("OpenGeni / CloudGeni")
    c.setSubject("Sites-first feature one-pager")

    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(HexColor("#23334B"))
    c.circle(PAGE_W - 45, PAGE_H + 12, 170, fill=1, stroke=0)
    c.setFillColor(HexColor("#252B36"))
    c.circle(PAGE_W - 4, PAGE_H - 10, 95, fill=1, stroke=0)

    margin = 36
    logo(c, margin, PAGE_H - 59, 25)
    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin + 35, PAGE_H - 37, "OpenGeni")
    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 8)
    c.drawString(margin + 96, PAGE_H - 37, "x")
    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin + 107, PAGE_H - 37, "CloudGeni")
    chip(c, "SITES FIRST", PAGE_W - margin - 73, PAGE_H - 46, BLUE_DEEP)

    c.setFillColor(FG)
    c.setFont("Helvetica-Bold", 26)
    c.drawString(margin, PAGE_H - 91, "Internal AI apps without per-app infrastructure.")
    para(
        c,
        "Generate a static SPA, review its exact AI and integration capabilities, and publish it to a stable authenticated URL. "
        "OpenGeni supplies durable AI, approved internal data and platform-owned approvals through one shared gateway.",
        margin,
        PAGE_H - 106,
        590,
        40,
        style("subtitle", 10.2, 14.2, MUTED),
    )
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 8.3)
    c.drawRightString(PAGE_W - margin, PAGE_H - 92, "Like Lovable for internal teams")
    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 7.7)
    c.drawRightString(PAGE_W - margin, PAGE_H - 106, "plus native AI + governed internal data")

    # Two clearly separated product lanes.
    lanes_top = PAGE_H - 150
    lane_gap = 12
    lane_width = (PAGE_W - 2 * margin - lane_gap) / 2
    lane(c, margin, lanes_top - 72, lane_width, "Native OpenGeni Sites", "DEFAULT", "Static SPAs, immutable releases, shared runtime gateway. No app backend or compute target.", GREEN, GREEN_SOFT)
    lane(c, margin + lane_width + lane_gap, lanes_top - 72, lane_width, "Advanced Deployments", "WHEN NEEDED", "Arbitrary full-stack workloads on customer cloud/Kubernetes through governed plans and providers.", PURPLE, SURFACE)

    # Main experience flow.
    flow_y = 293
    gap = 9
    flow_width = (PAGE_W - 2 * margin - 4 * gap) / 5
    stages = [
        ("Describe + build", "Ordinary durable authoring session, files, steering and tests.", BLUE),
        ("Preview", "Exact HTML in an isolated opaque-origin artifact frame.", GOLD),
        ("Review", "Models, instructions, tools, integrations, approvals and budget.", PURPLE),
        ("Publish", "Immutable artifact + manifest digest at one stable workspace URL.", GREEN),
        ("Run", "Durable AI, SSE, approved data, usage, rollback and archive.", BLUE),
    ]
    c.setFillColor(SUBTLE)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(margin, flow_y + 70, "THE SITE HAPPY PATH")
    for index, (title, copy, accent) in enumerate(stages, 1):
        x = margin + (index - 1) * (flow_width + gap)
        stage(c, index, title, copy, x, flow_y, flow_width, accent)

    # Lower three-column technical story.
    lower_y, lower_h, lower_gap = 103, 177, 12
    lower_width = (PAGE_W - 2 * margin - lower_gap * 2) / 3

    x1 = margin
    box(c, x1, lower_y, lower_width, lower_h)
    para(c, "How native AI connects", x1 + 15, lower_y + lower_h - 15, lower_width - 30, 20, SECTION)
    nodes = [
        ("Static Site", "opaque iframe", GREEN),
        ("Site shell", "authenticated parent", BLUE),
        ("Runtime gateway", "release + user policy", PURPLE),
        ("OpenGeni session", "durable AI + tools", GOLD),
    ]
    node_y = lower_y + lower_h - 55
    for index, (title, copy, accent) in enumerate(nodes):
        c.setFillColor(accent)
        c.roundRect(x1 + 15, node_y - 2, 6, 19, 3, fill=1, stroke=0)
        c.setFillColor(SURFACE_2)
        c.roundRect(x1 + 25, node_y - 2, lower_width - 40, 19, 6, fill=1, stroke=0)
        c.setFillColor(FG)
        c.setFont("Helvetica-Bold", 7.8)
        c.drawString(x1 + 34, node_y + 5, title)
        c.setFillColor(SUBTLE)
        c.setFont("Helvetica", 6.7)
        c.drawRightString(x1 + lower_width - 24, node_y + 5, copy)
        if index < len(nodes) - 1:
            c.setStrokeColor(BORDER)
            c.line(x1 + lower_width / 2, node_y - 5, x1 + lower_width / 2, node_y - 10)
        node_y -= 29
    para(c, "Typed MessageChannel only - no API key, cookie, generic fetch or credential enters the Site.", x1 + 15, lower_y + 24, lower_width - 30, 18, style("channel-note", 6.5, 8.0, MUTED))

    x2 = x1 + lower_width + lower_gap
    box(c, x2, lower_y, lower_width, lower_h)
    para(c, "Where data lives", x2 + 15, lower_y + lower_h - 15, lower_width - 30, 20, SECTION)
    rows = [
        ("Site HTML", "OpenGeni object storage, hash-bound", BLUE),
        ("Releases + sessions", "OpenGeni Postgres with FORCE RLS", PURPLE),
        ("Source data", "Existing system or local knowledge", GREEN),
        ("Credentials", "Encrypted server-side broker only", GOLD),
        ("Model path", "Configured local or declared route", BLUE),
    ]
    top = lower_y + lower_h - 45
    for title, copy, accent in rows:
        dot_row(c, x2 + 15, top, lower_width - 30, title, copy, accent)
        top -= 25

    x3 = x2 + lower_width + lower_gap
    box(c, x3, lower_y, lower_width, lower_h)
    para(c, "Governed by every release", x3 + 15, lower_y + lower_h - 15, lower_width - 30, 20, SECTION)
    guardrails = [
        ("Immutable capability manifest", "No silent permission widening."),
        ("Current user authority", "Rechecked at runtime admission."),
        ("Platform approvals", "Generated HTML cannot fake a write prompt."),
        ("Usage + budget", "Attributed to exact Site and release."),
        ("Rollback + archive", "No infrastructure mutation required."),
    ]
    top = lower_y + lower_h - 45
    for title, copy in guardrails:
        dot_row(c, x3 + 15, top, lower_width - 30, title, copy, GREEN)
        top -= 25

    # SINTEF reference ribbon and footer.
    c.setFillColor(BLUE_SOFT)
    c.roundRect(margin, 48, PAGE_W - 2 * margin, 40, 9, fill=1, stroke=0)
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(margin + 14, 73, "SINTEF REFERENCE")
    para(c, "Host the Site, OpenGeni, approved knowledge/MCP adapter and inference route locally. Demonstrate AI, update and rollback without a Kubernetes workload; enable Advanced Deployments separately only for a real backend need.", margin + 14, 68, PAGE_W - 2 * margin - 28, 22, style("reference", 7.5, 9.7, FG))

    c.setFillColor(SUBTLE)
    c.setFont("Helvetica", 6.7)
    c.drawString(margin, 25, "STATIC BY DEFAULT  /  DURABLE AI  /  INTERNAL DATA STAYS GOVERNED")
    c.drawRightString(PAGE_W - margin, 25, "opengeni.ai  /  cloudgeni.ai")
    c.showPage()
    c.save()


if __name__ == "__main__":
    render()
    print(OUTPUT)
