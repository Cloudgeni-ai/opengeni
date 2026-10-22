// Icons and store tiles for a product's branded build, from its own mark:
//   bun scripts/brand-icons.ts --mark logo.svg --out brand/icons [--tile "#202020"]
// The mark (SVG or PNG) fills a rounded tile when `--tile` is given, else it
// sits on a transparent background. The store tiles use the tile color, or
// white, behind the mark.

import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mark: { type: "string" },
    out: { type: "string" },
    tile: { type: "string" },
  },
});
if (!args.mark || !args.out) {
  throw new Error(
    "usage: bun scripts/brand-icons.ts --mark <svg|png> --out <dir> [--tile <color>]",
  );
}
if (args.tile && !/^#[0-9a-f]{3,8}$/iu.test(args.tile))
  throw new Error("--tile must be a hex color");
const markFile = resolve(process.cwd(), args.mark);
const out = resolve(process.cwd(), args.out);
const markBytes = await readFile(markFile);
const isSvg = extname(markFile).toLowerCase() === ".svg";
await mkdir(out, { recursive: true });

// The popup shows brand-mark.svg; a PNG mark is embedded in one.
if (isSvg) {
  await Bun.write(resolve(out, "brand-mark.svg"), markBytes);
} else {
  const { width = 1, height = 1 } = await sharp(markBytes).metadata();
  await Bun.write(
    resolve(out, "brand-mark.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${markBytes.toString("base64")}"/></svg>\n`,
  );
}

const fitted = (size: number) =>
  sharp(markBytes, { density: 600 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

for (const size of [16, 32, 48, 128]) {
  // Chrome's guidance: a 96 px mark inside a 128 px icon, scaled down alike.
  const tile = Math.round((size * 96) / 128);
  const inset = (size - tile) / 2;
  const markSize = args.tile ? Math.round(tile * 0.72) : tile;
  const layers: sharp.OverlayOptions[] = [];
  if (args.tile) {
    const radius = Math.max(2, Math.round(tile / 6));
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="${args.tile}"/></svg>`,
      ),
      top: 0,
      left: 0,
    });
  }
  const offset = Math.round((size - markSize) / 2);
  layers.push({ input: await fitted(markSize), top: offset, left: offset });
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toFile(resolve(out, `icon-${size}.png`));
}

// Store-only tiles, kept beside the icons for the listing.
for (const [name, width, height, markSize] of [
  ["promo-small.png", 440, 280, 160],
  ["promo-marquee.png", 1400, 560, 320],
] as const) {
  await sharp({
    create: { width, height, channels: 3, background: args.tile ?? "#ffffff" },
  })
    .composite([
      {
        input: await fitted(markSize),
        top: Math.round((height - markSize) / 2),
        left: Math.round((width - markSize) / 2),
      },
    ])
    .png()
    .toFile(resolve(out, name));
}
