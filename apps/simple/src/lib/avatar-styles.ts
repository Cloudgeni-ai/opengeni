/**
 * Avatar styles are color palettes. Every avatar is one silhouette glyph that
 * the app fills with the palette's colors, so switching style recolors every
 * agent at once and never repaints anything.
 */
export type AvatarStyle = {
  id: string;
  name: string;
  blurb: string;
};

export type AvatarColors = {
  /** CSS background of the tile (a color or a gradient). */
  background: string;
  /** Glyph color. */
  glyph: string;
  /** A hairline for pale tiles that would melt into the page. */
  ring?: string;
};

export const AVATAR_STYLES: AvatarStyle[] = [
  { id: "soft", name: "Soft", blurb: "Pastel tiles, a different hue per agent." },
  { id: "vivid", name: "Vivid", blurb: "Bright gradients with a white glyph." },
  { id: "ink", name: "Ink", blurb: "Off-white glyph on a dark tile." },
  { id: "paper", name: "Paper", blurb: "Ink glyph on off-white." },
  { id: "brand", name: "Opengeni", blurb: "Ink on teal and peach." },
  { id: "mono", name: "Mono", blurb: "Quiet grays, nothing else." },
];

export const DEFAULT_AVATAR_STYLE = "soft";

export function avatarStyleId(id: string | null | undefined) {
  return AVATAR_STYLES.some((style) => style.id === id) ? id! : DEFAULT_AVATAR_STYLE;
}

/** A stable hue per agent, spread around the wheel. */
export function agentHue(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

const BRAND = ["#79d9c1", "#ffb787", "#b9b2ff"];

export function avatarColors(styleId: string, seed: string, dark: boolean): AvatarColors {
  const hue = agentHue(seed);
  switch (avatarStyleId(styleId)) {
    case "vivid":
      return {
        background: `linear-gradient(135deg, hsl(${hue} 80% 62%), hsl(${(hue + 45) % 360} 85% 54%))`,
        glyph: "#ffffff",
      };
    case "ink":
      return dark
        ? { background: "#f4f4f2", glyph: "#242424" }
        : { background: "#242424", glyph: "#f4f4f2" };
    case "paper":
      return dark
        ? { background: "#2e2d2b", glyph: "#f4f4f2", ring: "rgba(255,255,255,0.08)" }
        : { background: "#f4f4f2", glyph: "#242424", ring: "rgba(0,0,0,0.08)" };
    case "brand":
      return { background: BRAND[hue % BRAND.length]!, glyph: "#242424" };
    case "mono":
      return dark
        ? { background: "#3a3936", glyph: "#d6d3d1" }
        : { background: "#e7e5e4", glyph: "#57534e" };
    default:
      return dark
        ? { background: `hsl(${hue} 32% 24%)`, glyph: `hsl(${hue} 75% 80%)` }
        : { background: `hsl(${hue} 75% 91%)`, glyph: `hsl(${hue} 50% 36%)` };
  }
}
