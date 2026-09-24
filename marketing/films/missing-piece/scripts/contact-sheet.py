"""Tile rendered frames into one labelled contact sheet for review.

    python3 scripts/contact-sheet.py out/stills out/review/sheet.png [columns] [tile_width]
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FPS = 60


def main() -> None:
    src = sys.argv[1]
    dst = sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    tile_w = int(sys.argv[4]) if len(sys.argv) > 4 else 640
    files = sorted(glob.glob(os.path.join(src, "f_*.png")) + glob.glob(os.path.join(src, "f_*.jpg")))
    if not files:
        raise SystemExit("no frames")
    tile_h = tile_w * 9 // 16
    label_h = 28
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_w + (cols + 1) * 8, rows * (tile_h + label_h) + (rows + 1) * 8), (30, 30, 28))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    for i, path in enumerate(files):
        frame = int(os.path.basename(path).split("_")[1].split(".")[0])
        im = Image.open(path).convert("RGB").resize((tile_w, tile_h), Image.LANCZOS)
        x = 8 + (i % cols) * (tile_w + 8)
        y = 8 + (i // cols) * (tile_h + label_h + 8)
        sheet.paste(im, (x, y + label_h))
        draw.text((x + 2, y + 4), f"{frame / FPS:6.2f}s  f{frame}", fill=(235, 235, 225), font=font)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    sheet.save(dst)
    print(dst, sheet.size)


if __name__ == "__main__":
    main()
