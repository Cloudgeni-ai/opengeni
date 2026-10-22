import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

// Reuse the approved web mark so Slack never grows a separate logo drawing.
const root = resolve(import.meta.dir, "..");
const favicon = await readFile(resolve(root, "apps/web/public/favicon.svg"), "utf8");
const path = favicon.match(/<path d="([^"]+)"/)?.[1];
if (!path) throw new Error("The shared favicon must contain the Opengeni brand path");
const directory = resolve(root, "deploy/slack");
await mkdir(directory, { recursive: true });

for (const staging of [false, true]) {
  const markWidth = staging ? 344 : 368;
  const scale = markWidth / 176;
  const x = (512 - markWidth) / 2;
  const y = ((staging ? 392 : 512) - 138.73 * scale) / 2;
  const banner = staging
    ? '<rect y="392" width="512" height="120" fill="#f5b942"/><text x="256" y="473" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" letter-spacing="3" fill="#111111">STAGING</text>'
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#ffffff"/><g transform="translate(${x} ${y}) scale(${scale})" fill="#111111"><path transform="translate(-75 -39.5966)" d="${path}"/></g>${banner}</svg>\n`;
  const name = staging ? "icon-staging" : "icon-production";
  await Bun.write(resolve(directory, `${name}.svg`), svg);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(resolve(directory, `${name}.png`));
}
