/**
 * Avatar house styles. Every agent in a workspace is painted in the same one,
 * so the sidebar reads as a set; an agent only supplies its subject.
 */
export type AvatarTheme = {
  id: string;
  name: string;
  blurb: string;
  style: string;
  /** Brand accents; each agent gets one, filling `{accent}` in the style. */
  accents?: string[];
};

const OPENGENI_ACCENTS = ["soft teal #79d9c1", "soft peach #ffb787"];
const OPENGENI_PALETTE =
  "use only the Opengeni palette: ink #242424, graphite #545454, light gray #c4c4c4, off-white #f4f4f2, white, soft teal #79d9c1 and soft peach #ffb787, no other hues";

export const OPENGENI_THEMES: AvatarTheme[] = [
  {
    id: "og-mono",
    name: "Mono + accent",
    blurb: "Ink glyph on off-white with one teal or peach detail.",
    style: `ultra minimal icon: one simple solid ink #242424 glyph centered on a plain off-white #f4f4f2 background, one small accent detail in {accent}, geometric and precise, generous empty space, no texture, no shadow, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-glow",
    name: "Mono on glow",
    blurb: "Ink glyph over the app's teal and peach corner glow.",
    style: `minimal icon: one simple solid ink #242424 glyph centered on an off-white background washed with a very soft blurred glow of pale teal #9fe3d3 from the top-left corner and pale peach #ffb787 from the bottom-right corner, generous empty space, no outlines, no texture, ${OPENGENI_PALETTE}`,
  },
  {
    id: "og-ink",
    name: "Ink tile",
    blurb: "Off-white glyph on a dark ink tile, one bright accent.",
    style: `minimal icon: one simple solid off-white glyph centered on a flat deep ink #242424 background, one small accent detail in {accent}, geometric, generous empty space, no gradients, no texture, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-wash",
    name: "Tinted wash",
    blurb: "Ink glyph on a flat teal or peach tile.",
    style: `minimal icon: one simple solid ink #242424 glyph centered on a flat pale tint of {accent} filling the whole background, generous empty space, no gradients, no outlines, no texture, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-line",
    name: "Ink line",
    blurb: "Thick rounded ink outline, one solid accent spot.",
    style: `minimal icon drawn as one thick rounded ink #242424 outline stroke with no fill, on a plain off-white #f4f4f2 background, one small solid shape in {accent}, generous empty space, no shading, no texture, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-gray",
    name: "Grayscale shapes",
    blurb: "Two or three flat grays with one accent.",
    style: `minimal flat icon: one simple glyph built from two or three flat gray tones (ink #242424, graphite #545454, light gray #c4c4c4) on a light gray #ececec background, one small accent detail in {accent}, generous empty space, no outlines, no gradients, no texture, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-duotone",
    name: "Brand duotone",
    blurb: "Glyph in two tones of teal or peach on its pale tint.",
    style: `minimal duotone flat icon: one simple bold glyph in a deep and a soft tone of {accent}, on a very pale tint of the same color, generous empty space, no outlines, no texture, no gradients, ${OPENGENI_PALETTE} plus darker shades of the accent`,
    accents: OPENGENI_ACCENTS,
  },
  {
    id: "og-cutout",
    name: "Ink paper cutout",
    blurb: "Ink paper shape on off-white, one colored paper piece.",
    style: `minimal flat paper cutout: one simple shape cut from ink-black paper layered over plain off-white paper, with one small piece cut from {accent} paper, a subtle soft drop shadow, no detail, generous empty space, ${OPENGENI_PALETTE}`,
    accents: OPENGENI_ACCENTS,
  },
];

export const AVATAR_THEMES: AvatarTheme[] = [
  ...OPENGENI_THEMES,
  {
    id: "clay",
    name: "Soft clay",
    blurb: "Chunky matte 3D clay, pastel and friendly.",
    style:
      "soft matte clay 3D render, chunky rounded shapes, pastel colors, soft studio lighting with gentle shadows, the subject centered on a soft pastel gradient background",
  },
  {
    id: "glass",
    name: "Glass orbs",
    blurb: "Glowing frosted glass, violet and pink light.",
    style:
      "the subject as a frosted luminous glass icon inside a glowing translucent glass orb, violet and pink light with a subtle color shift per agent, soft glow, deep violet gradient background",
  },
  {
    id: "flat",
    name: "Flat geometric",
    blurb: "Bold vector shapes, two or three solid colors.",
    style:
      "bold flat geometric vector illustration, two or three solid colors, no gradients and no shading, simple circles and rounded shapes, one solid saturated background color",
  },
  {
    id: "watercolor",
    name: "Storybook watercolor",
    blurb: "Hand-painted creatures with friendly faces.",
    style:
      "soft hand-painted watercolor storybook illustration in the spirit of Japanese animated films, the subject as a cute little creature with a friendly face, warm paper texture, gentle washes of color",
  },
  {
    id: "pixel",
    name: "Pixel art",
    blurb: "Crisp retro sprites with a limited palette.",
    style:
      "crisp 32x32 retro pixel art sprite with visible square pixels, limited vibrant palette, centered on a solid colored background",
  },
  {
    id: "origami",
    name: "Origami",
    blurb: "Folded paper sculptures with real shadows.",
    style:
      "folded origami paper sculpture with crisp folds and creases, soft realistic shadows, on a pastel paper background",
  },
  {
    id: "mascot",
    name: "Mascot family",
    blurb: "One fluffy creature species, a different prop per agent.",
    style:
      "always the SAME species of mascot: a small round fluffy spirit creature with big friendly eyes, identical body and face in every image, wearing or holding a prop that shows the subject, cute character design, soft shading, soft pastel background",
  },
  {
    id: "line",
    name: "Line on gradient",
    blurb: "One white monoline icon on a vivid gradient.",
    style:
      "a single clean white monoline icon with rounded strokes, centered on a vivid smooth two-color gradient background, a different gradient per agent, minimal premium app icon",
  },
  {
    id: "sticker",
    name: "Retro sticker",
    blurb: "70s die-cut stickers, warm muted palette.",
    style:
      "retro 1970s die-cut sticker illustration with a thick white outline, warm muted palette of orange, mustard, teal and cream, slight halftone texture, on a solid warm background",
  },
  {
    id: "isometric",
    name: "Isometric worlds",
    blurb: "Tiny 3D dioramas on floating platforms.",
    style:
      "a cute tiny isometric 3D diorama about the subject on a small floating square platform, soft colors, clean low-poly look, pastel background",
  },
  {
    id: "duotone",
    name: "Duotone",
    blurb: "One simple glyph in two tones of one hue.",
    style:
      "minimal duotone flat icon: one simple bold glyph in two tones of a single hue, on a pale tint of the same hue, generous empty space, no outlines, no texture, no gradients, a different hue per agent",
  },
  {
    id: "mono",
    name: "Mono",
    blurb: "Black glyph on white, nothing else.",
    style:
      "ultra minimal monochrome icon: one simple solid black glyph centered on a plain off-white background, geometric and precise, generous empty space, no color, no texture, no shadow",
  },
  {
    id: "outline",
    name: "Tinted outline",
    blurb: "Thick rounded colored outline on a pale tile.",
    style:
      "minimal icon drawn as one thick rounded outline stroke in a single saturated color, on a very pale tint of that color, no fill, no shading, generous empty space, a different color per agent",
  },
  {
    id: "glyph",
    name: "Glyph on gradient",
    blurb: "Solid white glyph on a soft gradient, like an app icon.",
    style:
      "minimal app icon: one simple solid white glyph centered on a soft, subtle two-color gradient background, clean and modern like a phone app icon, no outlines, no texture, a different gradient per agent",
  },
  {
    id: "cutout",
    name: "Paper cutout",
    blurb: "Two flat paper layers with a soft shadow.",
    style:
      "minimal flat paper cutout: one simple shape cut from colored paper layered over a plain paper background of a lighter tone, a subtle soft drop shadow, no detail, no texture beyond paper, a different color per agent",
  },
];

export const DEFAULT_AVATAR_THEME = "clay";

/** The theme's style for one agent, with its brand accent picked stably from `seed`. */
export function themeStyle(theme: AvatarTheme, seed: string): string {
  if (!theme.accents?.length) return theme.style;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return theme.style.replaceAll("{accent}", theme.accents[hash % theme.accents.length]!);
}

export function avatarTheme(id: string | null | undefined): AvatarTheme {
  return (
    AVATAR_THEMES.find((theme) => theme.id === id) ??
    AVATAR_THEMES.find((theme) => theme.id === DEFAULT_AVATAR_THEME)!
  );
}
