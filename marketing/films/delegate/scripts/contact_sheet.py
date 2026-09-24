"""Tile review frames into labelled contact sheets.

Usage: python3 scripts/contact_sheet.py <out.png> <cols> <frame.png>...
"""
import sys
from PIL import Image, ImageDraw, ImageFont

out, cols, *paths = sys.argv[1:]
cols = int(cols)
thumbs = [Image.open(p).convert("RGB") for p in paths]
w = 960
h = int(thumbs[0].height * w / thumbs[0].width)
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w + (cols + 1) * 8, rows * (h + 34) + 8), (40, 40, 40))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("public/fonts/JetBrainsMono.ttf", 22)
except OSError:
    font = ImageFont.load_default()
for i, (im, p) in enumerate(zip(thumbs, paths)):
    r, c = divmod(i, cols)
    x = 8 + c * (w + 8)
    y = 8 + r * (h + 34)
    sheet.paste(im.resize((w, h), Image.LANCZOS), (x, y + 26))
    draw.text((x, y), p.split("/")[-1], fill=(230, 230, 230), font=font)
sheet.save(out)
print(out, sheet.size)
