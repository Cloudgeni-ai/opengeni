// One-shot generator for the "screen capture failed" error-card PNG that the
// history-sanitizer wire seam substitutes for an empty computer_call_output image
// (see rewriteEmptyComputerCallOutputImageUrls). The hosted computer_use_preview
// protocol only has an IMAGE channel to the model, so a capture failure must be
// rendered as a legible image rather than a blank the model misreads as a real
// empty desktop.
//
// Run: `bun run scripts/gen-screenshot-error-card.mjs` → prints the data-URI base64
// (bake it into history-sanitizer.ts) plus an ASCII preview for visual verification.
// The output is a valid 8-bit RGBA PNG; validate it independently before baking.
//
// Dependency-free (embedded 5x7 bitmap font + hand-rolled PNG via node:zlib), so
// the runtime never needs a canvas/image dependency.
import { deflateSync } from "node:zlib";

// 5x7 uppercase bitmap font — only the glyphs the message uses (# = on). Verified by
// the ASCII preview this script prints.
const FONT = {
  A: ".###.\n#...#\n#...#\n#####\n#...#\n#...#\n#...#",
  B: "####.\n#...#\n#...#\n####.\n#...#\n#...#\n####.",
  C: ".####\n#....\n#....\n#....\n#....\n#....\n.####",
  D: "####.\n#...#\n#...#\n#...#\n#...#\n#...#\n####.",
  E: "#####\n#....\n#....\n####.\n#....\n#....\n#####",
  F: "#####\n#....\n#....\n####.\n#....\n#....\n#....",
  G: ".####\n#....\n#....\n#..##\n#...#\n#...#\n.####",
  H: "#...#\n#...#\n#...#\n#####\n#...#\n#...#\n#...#",
  I: "#####\n..#..\n..#..\n..#..\n..#..\n..#..\n#####",
  K: "#...#\n#..#.\n#.#..\n##...\n#.#..\n#..#.\n#...#",
  L: "#....\n#....\n#....\n#....\n#....\n#....\n#####",
  M: "#...#\n##.##\n#.#.#\n#.#.#\n#...#\n#...#\n#...#",
  N: "#...#\n##..#\n#.#.#\n#.#.#\n#..##\n#...#\n#...#",
  O: ".###.\n#...#\n#...#\n#...#\n#...#\n#...#\n.###.",
  P: "####.\n#...#\n#...#\n####.\n#....\n#....\n#....",
  R: "####.\n#...#\n#...#\n####.\n#.#..\n#..#.\n#...#",
  S: ".####\n#....\n#....\n.###.\n....#\n....#\n####.",
  T: "#####\n..#..\n..#..\n..#..\n..#..\n..#..\n..#..",
  U: "#...#\n#...#\n#...#\n#...#\n#...#\n#...#\n.###.",
  Y: "#...#\n#...#\n.#.#.\n..#..\n..#..\n..#..\n..#..",
  ",": ".....\n.....\n.....\n.....\n..##.\n..#..\n.#...",
  ".": ".....\n.....\n.....\n.....\n.....\n.##..\n.##..",
  " ": ".....\n.....\n.....\n.....\n.....\n.....\n.....",
};

const GLYPH_W = 5;
const GLYPH_H = 7;

const LINES = [
  "SCREEN CAPTURE FAILED",
  "THE DESKTOP COULD NOT BE CAPTURED.",
  "THIS IS A PLACEHOLDER, NOT THE REAL SCREEN.",
  "DO NOT SAY THE SCREEN IS BLANK.",
  "TELL THE USER TO CHECK THE DISPLAY AND GRANT",
  "SCREEN RECORDING PERMISSION.",
];

const SCALE = 5; // px per font pixel
const CHAR_GAP = 1; // font px between chars
const MARGIN = 24; // px
const LINE_GAP = 6; // font px between lines
const BG = [24, 20, 28, 255]; // charcoal
const HEADER_BG = [150, 30, 30, 255]; // red header band (first line)
const FG = [245, 240, 235, 255]; // near-white text

const cols = Math.max(...LINES.map((l) => l.length));
const contentWpx = cols * (GLYPH_W + CHAR_GAP) - CHAR_GAP;
const contentHpx = LINES.length * GLYPH_H + (LINES.length - 1) * LINE_GAP;
const W = contentWpx * SCALE + MARGIN * 2;
const H = contentHpx * SCALE + MARGIN * 2;

const buf = new Uint8Array(W * H * 4);
const setPx = (x, y, rgba) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  buf[o] = rgba[0];
  buf[o + 1] = rgba[1];
  buf[o + 2] = rgba[2];
  buf[o + 3] = rgba[3];
};

// Background + red header band behind the first line.
const headerBandH = MARGIN + GLYPH_H * SCALE + LINE_GAP * SCALE;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) setPx(x, y, y < headerBandH ? HEADER_BG : BG);
}

// Blit a scaled font pixel as a SCALE×SCALE block.
const blitBlock = (px, py, rgba) => {
  for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) setPx(px + dx, py + dy, rgba);
};

for (let li = 0; li < LINES.length; li++) {
  const line = LINES[li];
  const originY = MARGIN + li * (GLYPH_H + LINE_GAP) * SCALE;
  for (let ci = 0; ci < line.length; ci++) {
    const glyph = FONT[line[ci]] ?? FONT[" "];
    const rows = glyph.split("\n");
    const originX = MARGIN + ci * (GLYPH_W + CHAR_GAP) * SCALE;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (rows[gy][gx] === "#") blitBlock(originX + gx * SCALE, originY + gy * SCALE, FG);
      }
    }
  }
}

// --- PNG encode (8-bit RGBA) -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (v) => Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const chunk = (type, data) => {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};

const ihdr = new Uint8Array(13);
ihdr.set(u32(W), 0);
ihdr.set(u32(H), 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// bytes 10..12 = 0 (compression, filter, interlace)

// Filter each scanline with filter type 0 (None).
const raw = new Uint8Array(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  raw.set(buf.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
}
const idat = deflateSync(raw, { level: 9 });

const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);

const b64 = png.toString("base64");
console.error(`# dimensions ${W}x${H}, png ${png.length} bytes, data-uri ${b64.length} b64 chars`);

// ASCII preview (downsampled) so the glyphs can be visually verified.
console.error("\n# preview:");
const step = Math.ceil(H / 40);
for (let y = 0; y < H; y += step) {
  let row = "";
  for (let x = 0; x < W; x += step) {
    const o = (y * W + x) * 4;
    row += buf[o] === FG[0] && buf[o + 1] === FG[1] ? "#" : " ";
  }
  console.error(row);
}

// stdout: the raw data URI to bake.
process.stdout.write(`data:image/png;base64,${b64}\n`);
