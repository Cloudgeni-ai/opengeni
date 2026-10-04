import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The web app's favicon owns the shared Opengeni mark. Derive extension
// assets from it rather than maintaining a second drawing of the logo.
const favicon = await readFile(resolve(root, "../web/public/favicon.svg"), "utf8");
const path = favicon.match(/<path d="([^"]+)"/)?.[1];
if (!path) throw new Error("The shared favicon must contain the Opengeni brand path");
const mark = `<path transform="translate(-75 -39.5966)" d="${path}"/>`;
const svg = (width: number, height: number, content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;

await mkdir(resolve(root, "icons"), { recursive: true });
await Bun.write(
  resolve(root, "icons/brand-mark.svg"),
  `${svg(176, 138.73, `<g fill="#111111">${mark}</g>`)}\n`,
);
// Transparent padding around a neutral tile keeps the filled mark legible
// on both light and dark Chrome toolbars.
const icon = svg(128, 128,
  `<rect x="16" y="16" width="96" height="96" rx="16" fill="#202020"/><g transform="translate(28 35.6234) scale(${72 / 176})" fill="#ffffff">${mark}</g>`);
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(icon)).resize(size, size).png().toFile(resolve(root, `icons/icon-${size}.png`));
}

await mkdir(resolve(root, "fonts"), { recursive: true });
const fontPackage = dirname(Bun.resolveSync("@fontsource-variable/dm-sans/package.json", root));
await cp(resolve(fontPackage, "files/dm-sans-latin-wght-normal.woff2"), resolve(root, "fonts/dm-sans-latin-wght-normal.woff2"));
await cp(resolve(fontPackage, "LICENSE"), resolve(root, "fonts/OFL.txt"));

// Store-only marketing assets never enter the extension package.
await mkdir(resolve(root, "store"), { recursive: true });
for (const [name, width, height, markWidth] of [
  ["promo-small.png", 440, 280, 176],
  ["promo-marquee.png", 1400, 560, 352],
] as const) {
  const scale = markWidth / 176;
  const x = (width - markWidth) / 2;
  const y = (height - 138.73 * scale) / 2;
  const promo = svg(width, height, `<rect width="${width}" height="${height}" fill="#202020"/><g transform="translate(${x} ${y}) scale(${scale})" fill="#ffffff">${mark}</g>`);
  await sharp(Buffer.from(promo)).removeAlpha().png().toFile(resolve(root, `store/${name}`));
}
