import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SESSION_AVATAR_ICONS, type SessionAvatar } from "@opengeni/contracts";
import sharp from "sharp";
import { SESSION_AVATAR_ICON_SVG } from "../src/integrations/session-avatar-icons";
import {
  createSessionAvatarImageToken,
  oklchToHex,
  renderSessionAvatarPng,
  sessionAvatarImageUrl,
  SESSION_AVATAR_IMAGE_SIZE,
  verifySessionAvatarImageToken,
} from "../src/integrations/session-avatar-image";

const SECRET = "slack-signing-secret";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const noImage = async () => null;

async function pixel(png: Buffer, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return `#${[data[at]!, data[at + 1]!, data[at + 2]!]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("bot avatar pictures for Slack", () => {
  test("a signed link carries exactly the avatar it was minted for", () => {
    const avatar: SessionAvatar = { kind: "emoji", emoji: "🚀", hue: 210 };
    const token = createSessionAvatarImageToken(SECRET, { workspaceId: WORKSPACE, avatar });
    expect(verifySessionAvatarImageToken(SECRET, token)).toEqual({
      workspaceId: WORKSPACE,
      avatar,
    });
    expect(verifySessionAvatarImageToken("another-secret", token)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ w: WORKSPACE, a: { kind: "image", artifactId: crypto.randomUUID() } }),
    ).toString("base64url");
    expect(verifySessionAvatarImageToken(SECRET, `${forged}.${signature}`)).toBeNull();
    expect(verifySessionAvatarImageToken(SECRET, `${payload}.${signature}.x`)).toBeNull();
    expect(verifySessionAvatarImageToken(SECRET, "x".repeat(5_000))).toBeNull();
    expect(
      sessionAvatarImageUrl("https://app.example.test/", SECRET, {
        workspaceId: WORKSPACE,
        avatar,
      }),
    ).toBe(`https://app.example.test/v1/public/session-avatars/${token}.png`);
  });

  test("colours match the console's oklch tiles", () => {
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
    // oklch(0.56 0.11 250), the console's blue letters tile.
    expect(oklchToHex(0.56, 0.11, 250)).toBe("#3d78b2");
  });

  test("every kind draws a square picture on its tile", async () => {
    const size = SESSION_AVATAR_IMAGE_SIZE;
    const letters = await renderSessionAvatarPng(
      { kind: "letters", letters: "RO", hue: 250 },
      noImage,
    );
    const icon = await renderSessionAvatarPng({ kind: "icon", icon: "rocket", hue: 250 }, noImage);
    const emoji = await renderSessionAvatarPng({ kind: "emoji", emoji: "🐛", hue: 120 }, noImage);
    for (const png of [letters, icon, emoji]) {
      expect(await sharp(png!).metadata()).toMatchObject({
        format: "png",
        width: size,
        height: size,
      });
    }
    expect(await pixel(letters!, 2, 2)).toBe("#3d78b2");
    expect(await pixel(icon!, 2, 2)).toBe("#3d78b2");
    expect(await pixel(emoji!, 2, 2)).toBe(oklchToHex(0.92, 0.045, 120));
    // The letters themselves are drawn in white.
    const { data } = await sharp(letters!).raw().toBuffer({ resolveWithObject: true });
    expect(data.some((value, index) => index % 4 === 0 && value > 240)).toBe(true);
  });

  test("an image avatar is cropped to a square, and a missing image draws nothing", async () => {
    const source = await sharp({
      create: { width: 600, height: 300, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const image = { kind: "image", artifactId: crypto.randomUUID() } as const;
    const png = await renderSessionAvatarPng(image, async () => source);
    expect(await sharp(png!).metadata()).toMatchObject({ width: 256, height: 256 });
    expect(await pixel(png!, 128, 128)).toBe("#ff0000");
    expect(await renderSessionAvatarPng(image, noImage)).toBeNull();
  });

  test("the icon drawings match the console's Lucide icons", async () => {
    const lucide = resolve(
      import.meta.dir,
      "../../../packages/react/node_modules/lucide-react/dist/esm/icons",
    );
    for (const name of SESSION_AVATAR_ICONS) {
      const { __iconNode } = (await import(`${lucide}/${name}.mjs`)) as {
        __iconNode: [string, Record<string, string>][];
      };
      const markup = __iconNode
        .map(
          ([tag, attributes]) =>
            `<${tag}${Object.entries(attributes)
              .filter(([key]) => key !== "key")
              .map(([key, value]) => ` ${key}="${value}"`)
              .join("")}/>`,
        )
        .join("");
      expect(SESSION_AVATAR_ICON_SVG[name], name).toBe(markup);
    }
  });
});
