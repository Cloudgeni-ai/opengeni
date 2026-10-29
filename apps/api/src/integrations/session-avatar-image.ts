import { createHmac, timingSafeEqual } from "node:crypto";
import { SessionAvatar as SessionAvatarSchema, type SessionAvatar } from "@opengeni/contracts";
import sharp from "sharp";
import { SESSION_AVATAR_ICON_SVG } from "./session-avatar-icons";

/**
 * A bot's avatar as a picture other apps can show (its Slack posts). Slack
 * takes a picture only as a URL it fetches without credentials, so the URL
 * carries the avatar itself, signed with a key derived from the deployment's
 * Slack signing secret. Nothing else is reachable through it: an emoji, icon
 * or letters avatar is drawn from the URL alone, and an image avatar names one
 * image in the chat's workspace that its chat already shows. A link keeps
 * drawing what it was minted for, so posts made before an avatar changed keep
 * their picture.
 */

const TOKEN_LABEL = "opengeni/session-avatar-image/v1";
const MAX_TOKEN_LENGTH = 2_048;
export const SESSION_AVATAR_IMAGE_SIZE = 256;
export const SESSION_AVATAR_IMAGE_PATH_PREFIX = "/v1/public/session-avatars/";

export type SessionAvatarImageClaim = { workspaceId: string; avatar: SessionAvatar };

function signingKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(TOKEN_LABEL).digest();
}

export function createSessionAvatarImageToken(
  secret: string,
  claim: SessionAvatarImageClaim,
): string {
  const payload = Buffer.from(
    JSON.stringify({ w: claim.workspaceId, a: claim.avatar }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionAvatarImageToken(
  secret: string,
  token: string,
): SessionAvatarImageClaim | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(
    createHmac("sha256", signingKey(secret)).update(payload).digest("base64url"),
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const { w, a } = value as { w?: unknown; a?: unknown };
    if (typeof w !== "string" || !/^[0-9a-f-]{36}$/u.test(w)) return null;
    const avatar = SessionAvatarSchema.safeParse(a);
    return avatar.success ? { workspaceId: w, avatar: avatar.data } : null;
  } catch {
    return null;
  }
}

/** The public URL of a bot's avatar picture. */
export function sessionAvatarImageUrl(
  publicBaseUrl: string,
  secret: string,
  claim: SessionAvatarImageClaim,
): string {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  return `${base}${SESSION_AVATAR_IMAGE_PATH_PREFIX}${createSessionAvatarImageToken(secret, claim)}.png`;
}

/** sRGB hex for a CSS `oklch(l c h)` colour, as the console draws avatar tiles. */
export function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) => {
      const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tileSvg(fill: string, content = ""): Buffer {
  const size = SESSION_AVATAR_IMAGE_SIZE;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${fill}"/>${content}</svg>`,
  );
}

/**
 * Draw an avatar as a square PNG, the way the console shows it. Slack rounds
 * the corners itself. `readImage` supplies an image avatar's bytes; null when
 * the image is gone.
 */
export async function renderSessionAvatarPng(
  avatar: SessionAvatar,
  readImage: () => Promise<Uint8Array | null>,
): Promise<Buffer | null> {
  const size = SESSION_AVATAR_IMAGE_SIZE;
  if (avatar.kind === "image") {
    const bytes = await readImage();
    if (!bytes) return null;
    return await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(size, size, { fit: "cover" })
      .png()
      .toBuffer();
  }
  if (avatar.kind === "letters") {
    const text = `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Liberation Sans, Arial, Helvetica, sans-serif" font-weight="700" font-size="${avatar.letters.length > 1 ? 104 : 120}" fill="#ffffff">${escapeXml(avatar.letters.toUpperCase())}</text>`;
    return await sharp(tileSvg(oklchToHex(0.56, 0.11, avatar.hue), text))
      .png()
      .toBuffer();
  }
  if (avatar.kind === "icon") {
    const scale = size / 2 / 24;
    const icon = `<g transform="translate(${size / 4} ${size / 4}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${SESSION_AVATAR_ICON_SVG[avatar.icon]}</g>`;
    return await sharp(tileSvg(oklchToHex(0.56, 0.11, avatar.hue), icon))
      .png()
      .toBuffer();
  }
  const tile = sharp(tileSvg(oklchToHex(0.92, 0.045, avatar.hue)));
  const glyph = await renderEmojiGlyph(avatar.emoji, Math.round(size * 0.6));
  // Without a colour emoji font the tile alone still marks the bot.
  return await (glyph ? tile.composite([{ input: glyph, gravity: "center" }]) : tile)
    .png()
    .toBuffer();
}

async function renderEmojiGlyph(emoji: string, box: number): Promise<Buffer | null> {
  try {
    const glyph = sharp({
      text: { text: escapeXml(emoji), font: "Noto Color Emoji 120", rgba: true, dpi: 72 },
    });
    const { width, height } = await glyph.metadata();
    if (!width || !height) return null;
    return await glyph
      .resize(box, box, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
