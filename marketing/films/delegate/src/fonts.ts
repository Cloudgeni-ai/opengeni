import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

const faces = [
  { family: "Inter", file: "Inter.ttf" },
  { family: "Archivo", file: "Archivo.ttf" },
  { family: "DM Sans", file: "DMSans.ttf" },
  { family: "JetBrains Mono", file: "JetBrainsMono.ttf" },
] as const;

export const fontsReady = Promise.all(
  [...faces.map(({ family, file }) =>
    loadFont({ family, url: staticFile(`fonts/${file}`), weight: "100 900" }),
  ), loadFont({ family: "Instrument Serif", url: staticFile("fonts/InstrumentSerif-Italic.ttf"), weight: "400", style: "italic" })],
);

export const F = {
  ui: "Inter, sans-serif",
  display: "Archivo, sans-serif",
  brandSans: "'DM Sans', sans-serif",
  serif: "'Instrument Serif', serif",
  mono: "'JetBrains Mono', monospace",
} as const;
